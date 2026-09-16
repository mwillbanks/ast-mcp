// @ts-nocheck
import { render } from "./render.js";
export interface Props {
  label: string;
}
export function TsxView({ label }: Props) {
  return render(<p>{label}</p>);
}
