// `orbits` layout — forceRadial rings around the viewport center: engine hubs
// (chains + crons) innermost, workflow instances on the middle ring; each
// instance's run satellites already orbit it, forming the outermost shells.
// Pure: node → ring radius. No d3, no DOM.

export const ORBIT_RADII = {
  engines: 140,
  instances: 320,
};

export const orbitRadius = (node) =>
  node.kind === "instance" ? ORBIT_RADII.instances : ORBIT_RADII.engines;

// Ring guides drawn faintly behind the graph, with a label each.
export const ORBIT_GUIDES = [
  { r: ORBIT_RADII.engines, label: "engines" },
  { r: ORBIT_RADII.instances, label: "instances" },
];
