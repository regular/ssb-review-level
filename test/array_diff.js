const array_diff = require('../array_diff')
const test = require('tape')

test('array_diff', t => {
  t.deepEqual(array_diff(
    [1, 2, [4,5], [6,7], ["abc"]],
    [2, 5, [4,5], [1,2,3], ["abc"]]
  ), {
    'del': [1, [6,7]],
    'put': [5, [1,2,3]]
  })
  t.end()

})
