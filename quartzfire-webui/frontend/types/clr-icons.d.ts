// Clarity Icons ships a <clr-icon> custom element (registered by the vendored
// clr-icons.min.js runtime loaded in app/layout.tsx).
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "clr-icon": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        shape?: string;
        size?: string | number;
        dir?: "up" | "down" | "left" | "right";
        flip?: "horizontal" | "vertical";
        title?: string;
      };
    }
  }
}

export {};
