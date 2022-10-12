import b from './b.js'
const num = Math.random()
export default `module:a?: ${num}
${b}`
if (import.meta.hot) {
  import.meta.hot.accept('./b.js')
}
