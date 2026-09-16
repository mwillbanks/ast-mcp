@php
import { render } from "./render";
class BladeService extends Base {
  run() { return render("café"); }
}
@endphp
<div>{{ render(title) }}</div>
