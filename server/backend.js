const _ = require('lodash')
const conf = require('nconf')
const shareDbMongo = require('sharedb-mongo')
const shareDbAccess = require('sharedb-access')
const racerSchema = require('racer-schema')
const shareDbHooks = require('sharedb-hooks')
const redisPubSub = require('sharedb-redis-pubsub')
const wsbusPubSub = require('sharedb-wsbus-pubsub')
const racer = require('racer')
const redis = require('redis-url')
const initAdmins = require('./initAdmins')

module.exports = (options) => {
  // ------------------------------------------------------->     storeUse     <#
  options.ee.emit('storeUse', racer)

  // ShareDB Setup
  let mongoUrl = conf.get('MONGO_URL')

  let mongo = shareDbMongo(mongoUrl, {
    allowAllQueries: true
  })

  let backend = (() => {
    // For horizontal scaling, in production, redis is required.
    if (conf.get('REDIS_URL') && !conf.get('NO_REDIS')) {
      let redisClient = redis.connect()
      let redisObserver = redis.connect()

      // Flush redis when starting the app.
      // When running in cluster this should only run on the first instance.
      // Currently only the detection of the first instance of deis.com cluster
      // is supported.
      // TODO: Implement detection of the first instance on kubernetes and azure
      if (options.flushRedis !== false) {
        redisClient.on('connect', () => {
          let [, , , instance] = (process.env.HOSTNAME || '').split('.')
          if (instance == null || instance === '1') {
            redisClient.flushdb((err, didSucceed) => {
              if (err) {
                console.log('Redis flushdb err:', err)
              } else {
                console.log('Redis flushdb success:', didSucceed)
              }
            })
          }
        })
      }

      let pubsub = redisPubSub({
        client: redisClient,
        observer: redisObserver
      })

      return racer.createBackend({
        db: mongo,
        pubsub: pubsub,
        extraDbs: options.extraDbs
      })

    // redis alternative
    } else if (conf.get('WSBUS_URL') && !conf.get('NO_WSBUS')) {
      let pubsub = wsbusPubSub(conf.get('WSBUS_URL'))

      return racer.createBackend({
        db: mongo,
        pubsub: pubsub,
        extraDbs: options.extraDbs
      })
    // For development
    } else {
      return racer.createBackend({
        db: mongo,
        extraDbs: options.extraDbs
      })
    }
  })()

  backend.use('query', pathQueryMongo)

  if (options.accessControl != null) {
    shareDbAccess(backend, { dontUseOldDocs: true })
  }
  if (options.schema != null) {
    racerSchema(backend, options.schema)
  }
  if (options.hooks != null) {
    shareDbHooks(backend)
    options.hooks(backend)
  }
  if (options.accessControl != null) {
    options.accessControl(backend)
  }

  backend.on('client', (client, reject) => {
    let req = client.upgradeReq
    if (!req) return

    let userId = req.session && req.session.userId
    let userAgent = req.headers && req.headers['user-agent']
    if (!options.silentLogs) console.log('[WS OPENED]:', userId, userAgent)

    client.once('close', () => {
      if (!options.silentLogs) console.log('[WS CLOSED]', userId)
    })
  })

  // ------------------------------------------------------->      backend       <#
  options.ee.emit('backend', backend)

  initAdmins(backend)

  return {backend, mongo, redis}
}

function pathQueryMongo (request, next) {
  let query = request.query
  if (_.isPlainObject(query)) return next()
  if (!_.isArray(query)) query = [ query ]
  request.query = { _id: { $in: query } }
  next()
}
