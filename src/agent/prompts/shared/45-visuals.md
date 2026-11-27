## Visual blocks

Alongside markdown, math, and Mermaid, three fenced families render as live artifacts.

**Charts — `chart` (alias `plot`).** Use for quantitative plots and functions; not for flows. The body is one JSON object (JSON5 is tolerated, but plain JSON is safest):

```chart
{
  "title": "Damped oscillation",
  "x": { "label": "time", "type": "linear", "domain": [0, 6] },
  "y": { "label": "amplitude" },
  "series": [
    { "type": "line", "label": "e^-t cos(6t)", "expression": "exp(-x)*cos(6*x)", "domain": [0, 6] },
    { "type": "scatter", "label": "samples", "x": [0, 1, 2], "y": [1, 0.2, -0.1] }
  ],
  "grid": true,
  "legend": true
}
```

Series types: `line`, `area`, `scatter`, `bar`, `histogram` (`data`, optional `bins`), `heatmap` (`x`, `y`, `z[y][x]`). A line/area/scatter series has either `x`+`y` arrays or an `expression`+`domain`; `samples` is optional. Axes accept `type` `linear` (default) or `log`, plus optional `label` and `domain`. Expressions use `x`, numbers, `+ - * / ^`, parentheses, and standard functions such as `sin`, `cos`, `tan`, `exp`, `log`, `ln`, `sqrt`, `abs`, `floor`, `ceil`, `round`, `min`, `max`; no assignments. Optional `annotations` are `[{ "x": 1, "y": 2, "text": "peak" }]`. Keep charts under a few thousand points.

**Digital timing — `wavedrom` (alias `wavejson`).** The body is WaveDrom JSON (JSON5 is tolerated), not JavaScript. Use it for clocks, buses, handshakes, setup/hold, and protocol timing; do not use Mermaid sequence diagrams for waveforms.

```wavedrom
{
  "signal": [
    { "name": "clk", "wave": "p......" },
    { "name": "data", "wave": "x.3.4.x", "data": ["A", "B"] }
  ]
}
```

**3D molecules and crystals — `pdb`, `cif`, `xyz`, `sdf`/`mol`, `mol2`.** Put the raw structure data in the fence; the language selects the format. Use `cif` for crystals (unit cell shown by default), `pdb` for proteins/small PDB structures, and `sdf`/`mol`/`xyz` for small molecules. The viewer is interactive and local; never wrap it in prose. Keep the structure small enough to read, and label the surrounding lesson normally.

Use `visual` for one precise freeform geometric figure (coordinate geometry, vectors, physical layout), `mermaid` for structure/flow/relationships, `chart` for data, `wavedrom` for timing, and the 3D formats for molecular or crystal structures. Do not emit TikZ, matplotlib, or Python code for these; the fenced formats above are the contract.
