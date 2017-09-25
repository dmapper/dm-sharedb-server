const React = require('react')
const ReactDOMServer = require('react-dom/server')
const { StaticRouter } = require('react-router')
const _ = require('lodash')
const url = require('url')
const path = require('path')
const async = require('async')
const conf = require('nconf')
const chalk = require('chalk')
const express = require('express')
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

const DEFAULT_SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 2 // 2 years
function getDefaultSessionUpdateInterval(sessionMaxAge) {
  // maxAge is in ms. Return in s. So it's 1/10nth of maxAge.
  return Math.floor(sessionMaxAge / 1000 / 10)
}

// Optional derby-login
let derbyLogin = null
try {
  require.resolve('derby-login')
  derbyLogin = require('derby-login')
} catch (e) { }

module.exports = (backend, appRoutes, error, options, cb) => {
  let MongoStore = connectMongo(expressSession)
  let mongoUrl = conf.get('MONGO_URL')

  let connectMongoOptions = { url: mongoUrl }
  if (options.sessionMaxAge) {
    connectMongoOptions.touchAfter = options.sessionUpdateInterval ||
      getDefaultSessionUpdateInterval(options.sessionMaxAge)
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

    // Client Apps routes
    // Memoize getting the end-user <head> code
    let getHead = _.memoize(options.getHead || (() => ''))

    function getClientEnv() {
      let env = {}
      let pub = conf.get('PUBLIC') || []
      pub.forEach(key => env[key] = conf.get(key))
      return env
    }

    expressApp.use('/', options.serverRouter)

    const App = options.App
    expressApp.use((req, res, next) => {
      const context = {}

      const markup = ReactDOMServer.renderToString(React.createElement(
        StaticRouter,
        {
          location: req.url,
          context: context
        },
        React.createElement(
          'div',
          null,
          React.createElement(App, null)
        )
      ))

      let model = req.model
      model.bundle((err, bundle) => {
        if (err) return next('500: ' + req.url + '. Error: ' + err)
        let html = defaultClientLayout({
          styles: process.env.NODE_ENV === 'production'
            ? resourceManager.getProductionStyles('appName') : '',
          head: getHead('appName'),
          markup,
          modelBundle: bundle,
          jsBundle: resourceManager.getResourcePath('bundle', 'main'),
          env: getClientEnv()
        })
        if (context.url) {
          // Somewhere a `<Redirect>` was rendered
          redirect(301, context.url)
        } else {
          // we're good, send the response
          res.send(html)
        }
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

function matchUrl(location, routes, cb) {
  match({ routes, location }, (err, redirectLocation, renderProps) => {
    if (err) return cb(err)
    cb(null, { redirectLocation, renderProps })
  })
}

// Misc middleware
function miscMiddleware(backend) {
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
