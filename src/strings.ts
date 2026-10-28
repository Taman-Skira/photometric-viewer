const copy = {
  title: 'Photometric Viewer',
  subtitle:
    'Drop an IES or LDT file and see how the light actually lands: on a street, in a room, grazing a wall. Physically based and rendered live in your browser.',
  privacy: 'Your files never leave your device.',
  unsupported:
    'Your browser does not support WebGL2 with float render targets, which the viewer needs. Please try a recent Chrome, Edge, Firefox or Safari.',
  sceneLabel: 'Scene',
  sceneUnavailable: 'Not available for this example',
  viewModeLabel: 'View mode',
  resetView: 'Reset view',
  returnToPreview: 'Return to preview',
  scenes: {
    street: 'Street',
    open: 'Open area',
    wall: 'Near a wall',
    room: 'Room',
    ldc: '3D LDC',
  },
  modes: {
    render: 'Render',
    isolines: 'Isolines',
    points: 'Points',
    ldc: '3D LDC',
  },
  pointPopup: {
    position: 'Position',
    illuminance: 'Illuminance',
  },
  ldc: {
    c0: 'C0–C180',
    c90: 'C90–C270',
    scale: 'outer ring is the peak',
  },
  loading: 'Loading…',
  dropHere: 'Drop your IES or LDT file',
  controlsHint: 'Drag to orbit · right-drag or shift-drag to pan · scroll or pinch to zoom',
  sections: {
    luminaire: 'Luminaire',
    placement: 'Placement',
    light: 'Light & atmosphere',
    photometry: 'Photometry',
  },
  upload: 'Open IES / LDT file',
  uploadHint: 'Click to browse or drop a file anywhere',
  fileError: 'Could not read this file: {{message}}',
  samplesTitle: 'Or try a sample',
  samples: {
    street: 'Taman Optimized Street Light',
    known: 'Traditional Street Light',
    washer: 'Wall Washer',
    spot: 'Narrow Spot 24°',
    downlight: 'Wide Downlight',
    pendant: 'Linear Pendant',
  },
  convert: {
    download: 'Download as {{format}}',
    warnings: 'Converted. Some details have no place in {{format}}:',
    error: 'Could not convert this file: {{message}}',
  },
  notTypeC: 'This file uses Type A/B photometry; it is displayed as Type C, so orientation may be off.',
  controls: {
    height: 'Mounting height',
    heightRoom: 'Height above floor',
    ceiling: 'Ceiling height',
    wallDistance: 'Distance to wall',
    tilt: 'Tilt',
    rotation: 'Rotation',
    count: 'Luminaires',
    layout: 'Arrangement',
    spacing: 'Spacing',
    wallFinish: 'Wall finish',
    figure: 'Person for scale',
    cct: 'Color temperature',
    haze: 'Haze',
    exposure: 'Exposure',
    glare: 'Glare',
    glareHint: 'Veiling glare seen by the camera (Stiles–Holladay)',
  },
  layouts: {
    single: 'One side',
    opposite: 'Opposite',
    staggered: 'Staggered',
  },
  finishes: {
    plaster: 'Plaster',
    brick: 'Brick',
  },
  stats: {
    flux: 'Luminous flux',
    maxIntensity: 'Peak intensity',
    beamAngle: 'Beam angle C0 / C90',
    fieldAngle: 'Field angle C0 / C90',
    upward: 'Upward light',
    efficacy: 'Efficacy',
    power: 'Power',
    symmetry: 'Symmetry',
  },
  symmetry: {
    none: 'None',
    rotational: 'Rotational',
    'c0-c180': 'C0–C180 plane',
    'c90-c270': 'C90–C270 plane',
    quadrant: 'Both planes',
  },
  darkSky: 'No light above the horizon. Friendly to the night sky.',
} as const;

function lookup(path: string): string | undefined {
  let value: unknown = copy;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : undefined;
}

export function tv(key: string, vars?: Record<string, unknown>): string {
  const text = lookup(key) ?? key;
  if (!vars) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}
