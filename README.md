# ssb-review-level

A view implemented on top of leveldb, for use with [ssb-revisions](https://github.com/regular/ssb-revisions).

Provides indexes which are persistent and can be streamed in order.

This is more or less a drop-in replacement for flumeview-level, for scuttlebutt applications that require mutable documents.

## Differences to flumeview-level

- In case a message is a revision of a prior message (e.g. it has revisionRoot and revisionBranch properties), your map function is called twice: once for the old value, once for the new value. (your map function typically does not care whether it is called for the old or new value. However, if it does, this information is provided in the third argument: true for new, false for old).

- all entries returned by `map(new_value)` are written to leveldb (same as with flumeview-level)
- all entries retunred by `map(old_value)` that are _not also included_ in what is retunred by `map(new_value)` are _deleted_ from leveldb.
- the stream retunred by `read({live:true})` may contain `{type: 'del', key: [..]}` items, if an object/document no longer is part of the query result.
- the key-value pair argument to `map()` has a thrid property: `meta`. It's an object containing two booleans: `forked` and `incomplete` that indicated problems with the history of the object.
- if revisions are present, ssb-revisions makes sure that map is called in the correct, causal order.

## Example

``` js
var ReviewLevel = require('ssb-review-level')

ssb.revisions.use('my_view', ReviewLevel(1, function map (kv) {
  return [ [kv.value.content.foo, kv.value.content.revisionRoot || kv.key] ] // array of array-keys
}))

ssb.publish({foo: 'bar'}, function (err, msg_A) {
  ssb.publish({foo: 'baz'}, function (err, msg_B) {
    ssb.publish({
      revisionRoot: msg_B.key,
      revisionBranch: msg_B.key
      foo: 'bar'
    }, function (err, msg_C) {
      // query ranges via pull-streams
      pull(
        revisions.my_view.read({gt: ['bar', null], lt: ['bar', undefined], live: true}),
        ... => {
          key: ['bar', msg_A.key],
          value: { 
            key: msg_A.key,
            value: { content: { foo: 'bar' } }
          } 
        }
        ... => {
          key: ['bar', msg_B.key],
          value: { 
            key: msg_C.key,
            value: {
              content: {
                foo: 'bar',
                revisionRoot: msg_B.key,
                revisionBranch: msg_B.key
              }
            }
          }
        }
      )
    })
  })
})
```
In the example above, msg C is a revision of msg B that causes the original message's key (B) to be included in the query result (because the revised message B now has the foo value that matches the query)

More examples can be found [here](https://github.com/regular/ssb-revisions/blob/master/indexes/warnings.js) and [here](https://github.com/regular/ssb-revisions/blob/master/indexes/generic.js)

The following was adapted from flumeview-level's README.

## API

### `ReviewLevel(version, map) => function`

#### `version`
The version of the view. Incrementing this number will cause the view to be re-built

#### `map`
A function with signature `(value, seq, is_new)`, where `value` is the item from the log coming past, and `seq` is the location of that value in the flume log. `is_new` is `true` if the function is called with a new (or the original) value, and `false` if it is called with the old value. In most cases you can ignore all arguments but the first.

This function **must return an Array** that's either empty or contains unique index key(s).
These index keys can then be queired to retrieve the stored value (see `get` and `read` below).

Examples of index key(s) you might return:
- `[]` - i.e. don't add any indexes for this `value`
- `['@mix']` - make an index entry for this value under string `@mix`
- `['@mix', '@mixmix']` - make an index entries for this value under both `@mix` AND `@mixmix`
- `[['@mix', 1524805117433]]` - make an index entry for this value under the key `['@mix', 1524805117433]` (anything can be a key in leveldb)

This last case is useful when you might want multiple entries under a particular key like `@mix` - if just use `@mix` then the index will get overwritten by future values coming in with the same key.
Extending the key to include some unique aspect (like a timestamp or the `seq` of the value) means you can have multiple indexes in your view which have a _similar_ key.

In a scenario with mutable documents however, you most likely want an index key like this:

- `['@mix', kv.value.content.revisionRoot || kv.key]` 

This ensures that a) differnt documents don't overwrite each other's index entry, and b) later revisions of the same document *do* overwrite previous index entries. ssb-revisions makes sure that map is called in the correct (causal) order (newest last)

#### `function`
ssb-review-level returns a function which follows the ssb-review pattern, enabling it to be installed into an instance of ssb-revisions.


### `get(key, cb)`

The keys for the values in `map` above would be `'@mix'`, `'@mixmix'`, or `['@mix', 1524805117433]`


### `read(opts) => pull-stream`

`opts` is similar to a level db query ([see level docs](https://github.com/Level/levelup#dbcreatereadstreamoptions)).

e.g.

```js
{
  live: true,     // this is an addition to the classic query options of level
  gte: '@mi',     // gte = greater than or equal to
  lt: null,       // lt = less than
  reverse: true,
  keys: true,
  values: true,
  seqs: false,
}
```

If you've created indexes that are Arrays (quite likely), you need to understand how Arrays and other value are ordered by leveldb.
This is because using leveldb is all about ordering keys so that you can do queries efficiently.
Because of the way a log-structured-merge-tree works (what level is) it can read adjacent records quickly (with a single seek) but jumping around is not as fast.
Read about the pattern of ordering of keys/ indexes flumeview-level uses [here](https://github.com/deanlandolt/bytewise) (actually uses [charwise](https://github.com/dominictarr/charwise) under the hood, but follows the bytewise spec).

Example of more advanced query:

```js
{
  gte: ['@mix', null],
  lte: ['@mix' undefined],
}
```

Assume this is an index where the keys are of the form `[@mentions, revisionRoot]`, then this query will get all documents where @mix is mentioned in the latest revision. (note `undefined` is the highest, `null` the lowest value in [bytewise](https://github.com/deanlandolt/bytewise#order-of-supported-structures) comparator)

If you wanted to get all mentions which _started with_ `@m` you could use:

```js
{
  gte: ['@m', null],
  lt: ['@m~', undefined],
}
```

Here `null` is the lowest value in the comparator, and the `~` is just a slightly unreliable hack to catch values below `@m~` as `~` is quite a high character (e.g. above Z) for lexicographic ordering (there are higher characters but english people are less likely to type them, check [ltgt](https://github.com/dominictarr/ltgt) to generate reliable limiting values).

Here's some lexographically ordered strings to help you catch the vibe:
'@nevernever', '@m', '@manowar', '@ma~', '@mo', '@m~'


## License

MIT


