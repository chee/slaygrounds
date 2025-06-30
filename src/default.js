export default `/** @jsxRuntime automatic */
/** @jsxImportSource solid-js */
import { render } from "solid-js/web"
import { createEffect, createSignal } from "solid-js"


function Counter() {
  const [count, setCount] = createSignal(1)
  const increment = () => setCount(count => count + 1)
	createEffect(() => {
		console.log(count())
	})
  return (
	    <button type="button" onClick={increment}>
	      {count()}
	    </button>
  )
}

render(
	() => <Counter />,
	document.getElementById("app")!
)
`
