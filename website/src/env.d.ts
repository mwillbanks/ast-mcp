declare module "*.css";
declare module "*.html" {
  const html: import("bun").HTMLBundle;
  export default html;
}
