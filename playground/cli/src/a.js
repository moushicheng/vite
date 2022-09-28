import b from './b'
export default 'a' + b
if (import.meta.hot) {
  import.meta.hot.accept('./b.js')
}
