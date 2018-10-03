var Flume = require('flumedb')
var Log = require('flumelog-offset')
var Revisions = require('ssb-revisions')
var Index = require('../')
var codec = require('flumecodec')
var u = require('ssb-revisions/test/test-helper')

require('test-ssb-review-index')(function (file, seed, cb) {
  u.createDB(file + 'blah', function(err, db) {
    db.revisions.use('index', Index(1, function (e) {
      console.log(e)
      return [e.key]
    }))
    cb(null, db)
  })
})


