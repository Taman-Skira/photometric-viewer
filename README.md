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

## Samples

The files in `public/photometry` are there so the page is useful before you open your own file. They include a Taman street optimization and a few other luminaires: a traditional street light, a spot, a downlight, a wall washer, and a linear pendant.

## License

[MIT](LICENSE)
