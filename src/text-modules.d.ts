// Shell scripts are bundled as text (see "rules" in wrangler.jsonc).
declare module "*.sh" {
  const text: string;
  export default text;
}
