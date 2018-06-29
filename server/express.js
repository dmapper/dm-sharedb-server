const _ = require('lodash')
const url = require('url')
const path = require('path')
const async = require('async')
const conf = require('nconf')
const chalk = require('chalk')
const express = require('express')
const fs = require('fs')
const expressSession = require('express-session')
const serveStatic = require('serve-static')
const favicon = require('serve-favicon')
const compression = require('compression')
const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
const methodOverride = require('method-override')
const connectMongo = require('connect-mongo')
const racerHighway = require('racer-highway')
const resourceManager = require('./resourceManager')
const defaultClientLayout = require('./defaultClientLayout')
const { matchRoutes } = require('react-router-config')

const DEFAULT_SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 2 // 2 years
function getDefaultSessionUpdateInterval (sessionMaxAge) {
  // maxAge is in ms. Return in s. So it's 1/10nth of maxAge.
  return Math.floor(sessionMaxAge / 1000 / 10)
}

// Optional derby-login
let derbyLogin = null
try {
  require.resolve('derby-login')
  derbyLogin = require('derby-login')
} catch (e) {}

module.exports = (backend, appRoutes, error, options, cb) => {
  let MongoStore = connectMongo(expressSession)
  let mongoUrl = conf.get('MONGO_URL')

  let connectMongoOptions = { url: mongoUrl }
  if (options.sessionMaxAge) {
    connectMongoOptions.touchAfter = options.sessionUpdateInterval ||
        getDefaultSessionUpdateInterval(options.sessionMaxAge)
  }
  if (process.env.MONGO_SSL_CERT_PATH && process.env.MONGO_SSL_KEY_PATH) {
    let sslCert = fs.readFileSync(process.env.MONGO_SSL_CERT_PATH)
    let sslKey = fs.readFileSync(process.env.MONGO_SSL_KEY_PATH)
    connectMongoOptions.mongoOptions = {
      server: {
        sslValidate: false,
        sslKey: sslKey,
        sslCert: sslCert
      }
    }
  }
  let sessionStore = new MongoStore(connectMongoOptions)
  sessionStore.on('connected', () => {
    let session = expressSession({
      secret: conf.get('SESSION_SECRET'),
      store: sessionStore,
      cookie: {
        maxAge: options.sessionMaxAge || DEFAULT_SESSION_MAX_AGE,
        secure: options.cookiesSecure || false
      },
      saveUninitialized: true,
      resave: false,
      // when sessionMaxAge is set, we want to update cookie expiration time
      // on each request
      rolling: !!options.sessionMaxAge
    })

    let clientOptions = {
      timeout: 5000,
      timeoutIncrement: 8000
    }
    let hwHandlers = racerHighway(backend, { session }, clientOptions)

    let expressApp = express()

    // ----------------------------------------------------->    logs    <#
    options.ee.emit('logs', expressApp)

    expressApp
      .use(compression())
      .use(serveStatic(options.publicPath))
      .use('/build/client', express.static(options.dirname + '/build/client'))
      .use(backend.modelMiddleware())
      .use(cookieParser())
      .use(bodyParser.json({ limit: options.bodyParserLimit }))
      .use(bodyParser.urlencoded({ extended: true, limit: options.bodyParserLimit }))
      .use(methodOverride())
      .use(session)

    // ----------------------------------------------------->    afterSession    <#
    options.ee.emit('afterSession', expressApp)

    // Pipe env to client through the model
    expressApp.use((req, res, next) => {
      if (req.xhr) return next()
      let model = req.model
      model.set('_session.env', global.env, next)
    })

    expressApp.use(hwHandlers.middleware)

    if (derbyLogin) {
      expressApp.use(derbyLogin.middleware(backend, options.login))
    } else {
      expressApp.use((req, res, next) => {
        let model = req.model
        if (req.session.userId == null) req.session.userId = model.id()
        model.set('_session.userId', req.session.userId, next)
      })
    }

    expressApp.use(miscMiddleware(backend))

    // ----------------------------------------------------->    middleware    <#
    options.ee.emit('middleware', expressApp)

    // Server routes
    // ----------------------------------------------------->      routes      <#
    options.ee.emit('routes', expressApp)

    // Client Apps routes
    // Memoize getting the end-user <head> code
    let getHead = _.memoize(options.getHead || (() => ''))

    function getClientEnv () {
      let env = {}
      let pub = conf.get('PUBLIC') || []
      pub.forEach(key => env[key] = conf.get(key))
      return env
    }

    expressApp.use((req, res, next) => {
      let matched = matchAppRoutes(req.url, appRoutes)
      if (!matched) return next()
      if (matched.redirect) return res.redirect(302, matched.redirect)
      let {appName} = matched

      // If client route found, render the client-side app
      let model = req.model
      model.bundle((err, bundle) => {
        if (err) return next('500: ' + req.url + '. Error: ' + err)
        let html = defaultClientLayout({
          styles: process.env.NODE_ENV === 'production'
              ? resourceManager.getProductionStyles(appName) : '',
          head: getHead(appName),
          modelBundle: bundle,
          jsBundle: resourceManager.getResourcePath('bundle', appName),
          env: getClientEnv()
        })
        res.status(200).send(html)
      })
    })

    expressApp
      .all('*', (req, res, next) => next('404: ' + req.url))
      .use(error)

    cb({
      expressApp: expressApp,
      upgrade: hwHandlers.upgrade,
      wss: hwHandlers.wss
    })
  })
}

function matchUrl (location, routes, cb) {
  let matched = matchRoutes(routes, location)
  console.log('> match', routes, location)
  console.log('> matched', matched)
  if (matched && matched.length) {
    // check if the last route has redirect
    let lastRoute = matched[matched.length - 1]
    if (lastRoute.route.redirect) {
      return { redirect: lastRoute.route.redirect }
    // explicitely check that path is present,
    // because it's possible that only the Root component was matched
    // which doesn't actually render anything real,
    // but just a side-effect of react-router config structure.
    } else if (lastRoute.route.path) {
      return { render: true }
    }
  }
  return false
}

function matchAppRoutes (location, appRoutes, cb) {
  let appNames = _.keys(appRoutes)
  for (let appName of appNames) {
    let routes = appRoutes[appName]
    let result = matchUrl(location, routes)
    if (result) return Object.assign({ appName }, result)
  }
  return false
}

// Misc middleware
function miscMiddleware (backend) {
  return (req, res, next) => {
    let model = req.model

    if (backend.ADMINS.indexOf(req.session.userId) !== -1) {
      model.set('_session.isAdmin', true)
    }
    if (req.cookies.redirect && (!req.cookies.redirectWhen ||
        req.cookies.redirectWhen === 'loggedIn') && req.session.loggedIn) {
      let redirectUrl = req.cookies.redirect
      res.clearCookie('redirectWhen')
      res.clearCookie('redirect')
      return res.redirect(redirectUrl)
    }

    if (!req.session.loggedIn) return next()
    let auth = model.at('auths.' + req.session.userId)
    auth.fetch(() => {
      // TODO: implement setting 'timestamps.lastactivity' through redis
      if (req.method === 'GET' && !req.xhr && auth.get()) {
        auth.set('timestamps.lastactivity', Date.now())
      }
      next()
    })
  }
}
