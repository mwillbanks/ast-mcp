import { render } from "./render.js";
export function JsxView({ label }) {
  return render(<p>{label}</p>);
}
