const handle = document.querySelector(".handle")! as HTMLButtonElement
const left = document.querySelector(".code")! as HTMLDivElement
const container = document.querySelector("#playground")! as HTMLDivElement

const initial = localStorage.getItem("playground:left") ?? `0 0 50%`
left.style.flex = initial

let dragging = false
let startX = 0
let startLeftWidth = 0

function drag(event: MouseEvent) {
  if (!dragging) return
  const deltaX = event.clientX - startX
  const containerWidth = container.offsetWidth
  let newLeftWidth = startLeftWidth + deltaX
  const minWidth = containerWidth * 0.2
  const maxWidth = containerWidth * 0.8
  newLeftWidth = Math.max(minWidth, Math.min(maxWidth, newLeftWidth))
  const leftPercent = (newLeftWidth / containerWidth) * 100
  left.style.flex = `0 0 ${leftPercent}%`
}

handle.addEventListener("mousedown", (event) => {
  handle.dataset.dragging = "dragging"
  dragging = true
  startX = event.clientX
  startLeftWidth = left.offsetWidth
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  document.addEventListener("mousemove", drag)
  document.addEventListener("mouseup", () => {
    document.removeEventListener("mousemove", drag)
    dragging = false
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    delete handle.dataset.dragging
    localStorage.setItem("playground:left", left.style.flex)
  }, { once: true })
})
