console.log('\n\n----------1--------')
path.resolve('1111')
import path from 'node:path'
import fs from 'node:fs'
console.log('----------2--------')
import('fs').then((res) => {
  console.log('success')
})
console.log('----------3--------')
path.resolve('server.js')
