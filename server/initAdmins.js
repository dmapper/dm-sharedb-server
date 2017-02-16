const async = require('async')
const conf = require('nconf')

// Populate admin id's
module.exports = (backend) => {
  backend.ADMINS = []
  let model = backend.createModel()
  let adminIds = model.at('service.adminIds')
  let superadmins = model.query('auths', { 'email': {
    $in: conf.get('ADMINS') || []
  } })
  model.fetch(adminIds, superadmins, () => {
    async.series([ (cb) => {
      if (adminIds.get() != null) {
        cb()
      } else {
        model.add('service', { id: 'adminIds', value: [] }, cb)
      }
    } ], () => {
      let theAdminIds = adminIds.get('value') || []
      superadmins.get().forEach((superadmin) => {
        if (theAdminIds.indexOf(superadmin.id) === -1) {
          adminIds.push('value', superadmin.id)
        }
      })
      backend.ADMINS = adminIds.get('value') || []
      console.log('Admins:', backend.ADMINS.length)
      model.close()
    })
  })
}
