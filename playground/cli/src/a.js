const num = Math.random()
export default `module:a?: ${num}
${b}`
const text = b
if (import.meta.hot) {
  import.meta.hot.accept('./b.js')
}
import b from './b.js'
