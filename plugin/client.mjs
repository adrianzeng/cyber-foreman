window.__ModuleLoader__.load({
  id: "@local/dsh-agent-hub",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");

    const PANEL_ID = "agent-hub";
    const HUB_URL = "http://127.0.0.1:4647";

    function Icon({ size = 20 }) {
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          "aria-hidden": true,
        },
        React.createElement("path", { d: "M5 7.5h14M5 12h9M5 16.5h14" }),
        React.createElement("circle", { cx: 18, cy: 12, r: 2 }),
      );
    }

    function Panel() {
      return React.createElement("iframe", {
        src: HUB_URL,
        title: "Agent Hub",
        style: {
          display: "block",
          width: "100%",
          height: "100%",
          minHeight: 0,
          border: 0,
          background: "var(--dsw-alias-bg-base, #f5f4ef)",
        },
      });
    }

    module.exports.inject = ["slots"];
    module.exports.apply = function apply(ctx) {
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
      }, Panel));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 25,
        label: "Agent Hub",
      }, Icon));
    };

    return module.exports;
  },
});
