# Photometric Viewer

Open an IES or EULUMDAT (LDT) file in the browser and see the light rendered live: on a street, in a room, next to a wall, or in an open area. Parsing and rendering stay on your device. Nothing is uploaded.

The viewer needs WebGL2 with float render targets. Recent Chrome, Edge, Firefox, and Safari all qualify.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints. Drop a `.ies` or `.ldt` file onto the page, or start from one of the included samples.

```bash
npm run build
npm run preview
```

## Convert IES <-> LDT from the command line

```bash
npx github:Taman-Skira/photometric-viewer convert input.ies output.ldt
npx github:Taman-Skira/photometric-viewer convert input.ldt            # writes input.ies
```

The formats follow the file extensions. Intensities, angles, symmetry, flux, power and dimensions carry over; metadata without a matching field in the target format is reported as a warning. Use `--force` to overwrite an existing output file and `--quiet` to hide warnings.

From a checkout, `npm run build:cli` builds `dist-cli/photometric-viewer.js`, which you can run with `node`.

## Tests

```bash
npm test
```

The IES and EULUMDAT readers, writers and the IES <-> LDT converter live in `src/photometry/formats`. They run in the browser and in Node and are tested against the sample files.

## Samples

The files in `public/photometry` are there so the page is useful before you open your own file. They include a Taman street optimization and a few other luminaires: a traditional street light, a spot, a downlight, a wall washer, and a linear pendant.

## License

[MIT](LICENSE)
