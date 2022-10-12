import a from './src/a.js'
const num = Math.random()
document.getElementById('app').innerText = a + num
if (import.meta.hot) {
  import.meta.hot.accept()
}
