var Flume = require('flumedb')
var Log = require('flumelog-offset')
var Index = require('../')
var codec = require('flumecodec')
var u = require('ssb-revisions/test/test-helper')

require('test-ssb-review-index/mutations')(function (file, seed, cb) {
  u.createDB(file + 'blah', function(err, db) {
    db.revisions.use('index', Index(1, function (e) {
      console.log('mapping', e)
      return e.value.content.groups
    }))
    cb(null, db)
  })
})

