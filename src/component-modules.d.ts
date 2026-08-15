declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component;
  export default component;
}

declare module '*.css' {
  const stylesheet: string;
  export default stylesheet;
}
