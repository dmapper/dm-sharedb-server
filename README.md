# dm-sharedb-server (react router 4)
> Express.js server with ShareDB, configs system, and react-router support for rendering client apps.

## Usage

config example, there are breaking changes from react router 3

``` 

  shareDbServer({
    App: App,
    appRoutes: {
      main: App //the main React compoent
    },
    getHead: getHead,
    beforeStart: beforeStart,
    serverRouter: router // instance of the express Router class
  }, (ee, options) => {
    //ee didn't needed anymore just pass express router to the config
  })

```

## MIT Licence

Copyright (c) 2016 Pavel Zhukov
