'use strict'
var pull = require('pull-stream')
var Level = require('level')
var charwise = require('charwise')
var Write = require('pull-write')
var pl = require('pull-level')
var Obv = require('obv')
var path = require('path')
var Paramap = require('pull-paramap')
var ltgt = require('ltgt')
var explain = require('explain-error')
var mkdirp = require('mkdirp')
var debug = require('debug')('ssb-review-level')
var array_diff = require('./array_diff')


module.exports = function (version, map) {
  return function (log, name) {
    var dir = path.dirname(log.filename)
    var dbPath = path.join(dir, name)
    var db, writer

    var META = '\x00', since = Obv()

    var written = 0, closed, outdated

    function create() {
      closed = false
      if(!log.filename)
        throw new Error('flumeview-level can only be used with a log that provides a directory')
      return Level(path.join(dir, name), {keyEncoding: charwise, valueEncoding: 'json'})
    }

    function close (cb) {
      closed = true
      //todo: move this bit into pull-write
      if (outdated) db.close(cb)
      else if(writer) writer.abort(function () { db.close(cb) })
      else if(!db) cb()
      else since.once(function () {
        db.close(cb)
      })
    }

    function destroy (cb) {
      close(function () {
        Level.destroy(dbPath, cb)
      })
    }

    mkdirp(path.join(dir, name), function () {
      if(closed) return
      db = create()
      db.get(META, {keyEncoding: 'utf8'}, function (err, value) {
        if(err) since.set(-1)
        else if(value.version === version)
          since.set(value.since)
        else {
          //version has changed, wipe db and start over.
          outdated = true
          destroy(function () {
            db = create()
            since.set(-1)
          })
        }
      })
    })
    var batch
    return {
      since: since,
      methods: { get: 'async', read: 'source'},
      createSink: function (cb) {
       return writer = Write(function (chunks, cb) {
          if(closed) return cb(new Error('database closed while index was building'))
          var newSince = chunks[0].value.since
          //console.log('Writing chunks:', chunks)
          db.batch(chunks, function (err) {
            if(err) return cb(err)
            debug('done writing chunks, since=%d', newSince)
            since.set(newSince)
            //callback to anyone waiting for this point.
            cb()
          })
        }, function reduce (chunks, data) {
          //if(data.sync) return batch
          if(data.since !== undefined) {
            //console.log('review-level got data.since', data.since, 'batch length', batch && batch.length)
            if (batch) {
              if (data.since > batch[0].value.since) {
                batch[0].value.since = data.since
                var ret =(chunks || []).concat(batch)
                ret[0].value.since = data.since
                batch = null
                return ret
              }
            } 
          }

          if(!batch)
            batch = [{
              key: META,
              value: {version: version, since: data.since !== undefined ? data.since : -1},
              valueEncoding: 'json', keyEncoding:'utf8'
            }]

          if (data.since == undefined) {
            //map must return an array (like flatmap) with zero or more values
            var new_entries = map(data.value, data.value.seq)
            var old_entries = data.old_value ? map(data.old_value, data.old_value.seq) : []
            var diff = array_diff(old_entries, new_entries)
            batch = batch.concat(diff.put.map(function (key) {
              return { key: key, value: data.value.seq, type: 'put' }
            }))
            batch = batch.concat(diff.del.map(function (key) {
              return { key: key, type: 'del' }
            }))
          }
          return chunks
        }, 512, cb) // TODO: newver write if we dont tell you to
      },

      get: function (key, cb) {
        //wait until the log has been processed up to the current point.
        db.get(key, function (err, seq) {
          if(err && err.name === 'NotFoundError') return cb(err)
          if(err) cb(explain(err, 'flumeview-level.get: key not found:'+key))
          else
            log.get(seq, function (err, value) {
              if(err) cb(explain(err, 'flumeview-level.get: index for:'+key+'pointed at:'+seq+'but log error'))
              else cb(null, value)
            })
        })
      },
      read: function (opts) {
        var keys = opts.keys !== false
        var values = opts.values !== false
        var seqs = opts.seqs !== false
        opts.keys = true; opts.values = true
        //TODO: preserve whatever the user passed in on opts...

        var lower = ltgt.lowerBound(opts)
        if(lower == null) opts.gt = null

        function format (key, seq, value) {
          return (
            keys && values && seqs ? {key: key, seq: seq, value: value}
          : keys && values         ? {key: key, value: value}
          : keys && seqs           ? {key: key, seq: seq}
          : seqs && values         ? {seq: seq, value: value}
          : keys ? key : seqs ? seq : value
          )
        }

        return pull(
          pl.read(db, opts),
          pull.filter(function (op) {
            //this is an ugly hack! ); but it stops the index metadata appearing in the live stream
            return op.key !== META
          }),
          values ?
          Paramap(function (data, cb) {
              if(data.sync) return cb(null, data)
              log.get(data.value, function (err, value) {
                if(err) cb(explain(err, 'when trying to retrive:'+data.key+'at since:'+log.since.value))
                else cb(null, format(data.key, data.value, value))
              })
            })
          : pull.map(function (data) {
              return format(data.key, data.value, null)
            })
        )
      },
      close: close,
      destroy: destroy
    }
  }
}
