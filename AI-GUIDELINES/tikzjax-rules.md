# TikZJax in the Browser — Definitive Rules & Reference

> **Context:** These rules apply specifically to the self-hosted `tikzjax.js` build
> (the `artisticat1/tikzjax` output-single-file fork), deployed on Vercel with a
> local `js/` asset folder. Derived from ~2 hours of live debugging on 25 April 2026.

---

## Table of Contents

1. [How this build works](#1-how-this-build-works)
2. [The golden template](#2-the-golden-template)
3. [data-add-to-preamble — the only working injection method](#3-data-add-to-preamble--the-only-working-injection-method)
4. [Required preamble sequence](#4-required-preamble-sequence)
5. [Script body rules](#5-script-body-rules)
6. [What NOT to do](#6-what-not-to-do)
7. [Bundled packages reference](#7-bundled-packages-reference)
8. [MathJax alongside TikZJax](#8-mathjax-alongside-tikzjax)
9. [Debugging checklist](#9-debugging-checklist)
10. [Full working example](#10-full-working-example)
11. [Error dictionary](#11-error-dictionary)

---

## 1. How this build works

Understanding the internals prevents hours of guesswork.

### Core dump architecture

The `tikzjax.js` bundle embeds **three things as base64 blobs**:

| Asset | What it is | How loaded |
|---|---|---|
| `core.dump.gz` | Frozen LaTeX memory snapshot | Embedded in JS, no HTTP fetch |
| `tex.wasm.gz` | WebAssembly TeX engine | Embedded in JS, no HTTP fetch |
| `tex_files/*.gz` | ~200 `.sty` / `.tex` packages | Embedded in JS, no HTTP fetch |

Nothing is fetched from your server at runtime. **All assets are self-contained.**

### The frozen preamble problem

The core dump is taken **after** these commands have already run:

```latex
\documentclass[margin=0pt]{standalone}
\def\pgfsysdriver{pgfsys-ximera.def}
\usepackage{tikz}
% -- DUMP TAKEN HERE --
```

This means when your diagram runs, LaTeX has already passed the preamble stage.
Any `\usepackage` in the wrong place is **fatal**.

### How input.tex is assembled

The `texify` function builds `input.tex` in this exact order:

```
[data-tex-packages injection]     ← BROKEN (double-backslash bug)
+ [data-tikz-libraries injection] ← BROKEN (double-backslash bug)
+ [data-add-to-preamble value]    ← WORKS (raw, no escaping)
+ [data-tikz-options value]
+ [script tag text content]       ← your \begin{tikzpicture}...\end{tikzpicture}
```

The command line TeX receives is:
```
input.tex \n\end\n
```

So the engine reads `input.tex`, then `\end` is appended automatically.
If you opened `\begin{document}` you must close it yourself with `\end{document}`.

---

## 2. The golden template

Copy this for every new diagram:

```html
<script type="text/tikz"
    data-add-to-preamble="\usepackage{PACKAGE}\begin{document}"
    data-show-console="true">
    \begin{tikzpicture}[your options]
        % your TikZ drawing commands here
    \end{tikzpicture}
    \end{document}
</script>
```

For packages that require a setup command before `\begin{document}`:

```html
<script type="text/tikz"
    data-add-to-preamble="\usepackage{PACKAGE}\SETUPCMD{args}\begin{document}"
    data-show-console="true">
    \begin{tikzpicture}[your options]
        % your TikZ drawing commands here
    \end{tikzpicture}
    \end{document}
</script>
```

> **Tip:** Once everything works, remove `data-show-console="true"` to keep
> the browser console clean in production.

---

## 3. `data-add-to-preamble` — the only working injection method

### Why it works

Inside `texify`, `data-add-to-preamble` is inserted **raw**:

```js
+ (e.addToPreamble || "")
```

No string processing. Whatever you put in the HTML attribute arrives at TeX
with **single backslashes** exactly as written.

### Why the alternatives are broken

| Attribute | Internal JS code | What TeX receives | Status |
|---|---|---|---|
| `data-add-to-preamble` | `e.addToPreamble \|\| ""` | `\usepackage{x}` ✓ | **Works** |
| `data-tex-packages` | `"\\\\usepackage{" + name + "}"` | `\\usepackage{x}` ✗ | Broken |
| `data-tikz-libraries` | `"\\\\usetikzlibrary{" + libs + "}"` | `\\usetikzlibrary{x}` ✗ | Broken |

The `\\\\` in the minified JS source becomes `\\` at JS runtime, which TeX
sees as a literal double-backslash — not a command.

### Syntax rules for `data-add-to-preamble`

- No spaces needed between commands — they run sequentially
- Multiple packages: `\usepackage{pkg1}\usepackage{pkg2}\begin{document}`
- Setup commands go between `\usepackage` and `\begin{document}`
- The value is a plain HTML attribute — no JSON, no escaping needed

---

## 4. Required preamble sequence

The order inside `data-add-to-preamble` is strict:

```
\usepackage{...}         Step 1 — load packages
\SETUPCOMMANDS{...}      Step 2 — run any required setup macros
\begin{document}         Step 3 — ALWAYS last, opens the document body
```

### Examples

**Basic package (no setup needed):**
```html
data-add-to-preamble="\usepackage{chemfig}\begin{document}"
```

**Package with required setup (tikz-3dplot):**
```html
data-add-to-preamble="\usepackage{tikz-3dplot}\tdplotsetmaincoords{70}{110}\begin{document}"
```

**Multiple packages:**
```html
data-add-to-preamble="\usepackage{pgfplots}\usepackage{amsmath}\begin{document}"
```

**No extra package needed (tikz only, already in core dump):**
```html
data-add-to-preamble="\begin{document}"
```

---

## 5. Script body rules

### What goes inside the `<script type="text/tikz">` tag

```latex
\begin{tikzpicture}[options]
    % drawing commands
\end{tikzpicture}
\end{document}
```

### Rules

| Rule | Reason |
|---|---|
| ✅ Start with `\begin{tikzpicture}` | The document body is already open via preamble |
| ✅ End with `\end{document}` | Required to match the `\begin{document}` in preamble |
| ❌ Do NOT include `\usepackage` | Preamble is frozen — fatal error |
| ❌ Do NOT include `\begin{document}` | Already opened in `data-add-to-preamble` |
| ❌ Do NOT include `\documentclass` | Already set in core dump |
| ❌ Do NOT include `\usetikzlibrary` as inline | Use `data-add-to-preamble` instead |

### Using `\usetikzlibrary` correctly

TikZ libraries (like `arrows.meta`, `calc`, `decorations`) are loaded via
`data-add-to-preamble`, not inside the script body:

```html
data-add-to-preamble="\usetikzlibrary{arrows.meta,calc}\begin{document}"
```

---

## 6. What NOT to do

These patterns look reasonable but will always fail in this build:

### ❌ Inline `\usepackage`
```html
<!-- WRONG — "Can be used only in preamble" fatal error -->
<script type="text/tikz">
    \usepackage{tikz-3dplot}
    \begin{tikzpicture}...
```

### ❌ `data-tex-packages` attribute
```html
<!-- WRONG — double-backslash bug produces \\usepackage -->
<script type="text/tikz" data-tex-packages='{"tikz-3dplot": ""}'>
```

### ❌ Missing `\end{document}`
```html
<!-- WRONG — TeX panics: "Emergency stop. <*> \end" -->
<script type="text/tikz" data-add-to-preamble="\usepackage{x}\begin{document}">
    \begin{tikzpicture}...\end{tikzpicture}
    <!-- forgot \end{document} -->
</script>
```

### ❌ `\tdplotsetmaincoords` without `\usepackage{tikz-3dplot}` first
```html
<!-- WRONG — undefined command -->
data-add-to-preamble="\tdplotsetmaincoords{70}{110}\begin{document}"
```

### ❌ `\begin{document}` inside the script body
```html
<!-- WRONG — "Missing \begin{document}" or document opened twice -->
<script type="text/tikz" data-add-to-preamble="\usepackage{x}\begin{document}">
    \begin{document}   ← remove this
    \begin{tikzpicture}...
```

---

## 7. Bundled packages reference

All of these are embedded as base64 in `tikzjax.js` — no network fetch required.

### Math & symbols
| Package | Usage |
|---|---|
| `amsmath` | Advanced math environments |
| `amssymb` | Extra math symbols |
| `amsfonts` | Math fonts |

### TikZ / PGF
| Package / Library | Usage |
|---|---|
| `tikz` | Core (pre-loaded in dump) |
| `tikz-3dplot` | 3D coordinate systems |
| `tikz-cd` | Commutative diagrams |
| `pgfplots` | Data plots and graphs |
| `tikzlibrary3d` | 3D canvas |
| `tikzlibrarycalc` | Coordinate calculations |
| `tikzlibraryarrows` | Arrow tips |
| `tikzlibraryarrows.meta` | Modern arrow tips |
| `tikzlibrarydecorations.*` | Path decorations |
| `tikzlibrarypositioning` | Node positioning |
| `tikzlibrarymatrix` | Matrix layouts |
| `tikzlibrarypatterns` | Fill patterns |
| `tikzlibraryshadings` | Gradient shadings |

### Science & engineering
| Package | Usage |
|---|---|
| `circuitikz` | Circuit diagrams |
| `chemfig` | Chemical structures |
| `tikz-feynhand` | Feynman diagrams |

### Utility
| Package | Usage |
|---|---|
| `array` | Table formatting |
| `ifthen` | Conditional logic |
| `quiver` | Quiver diagrams |

---

## 8. MathJax alongside TikZJax

### Configuration (must come BEFORE the MathJax script tag)

```html
<script>
    MathJax = {
        tex: {
            inlineMath:  [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']],
            tags: 'ams',
        },
        options: {
            skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre'],
        },
    };
</script>
<script id="MathJax-script" async
    src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
</script>
```

### Known non-fatal warnings (safe to ignore)

```
"mathvariant='double-struck'" on MathML elements is deprecated
Inferring the accent property from the core operator is deprecated
GET /js/css/bakoma/ttf/cmmi10.ttf 404
GET /js/css/bakoma/ttf/cmmi9.ttf 404
```

These are browser/MathJax deprecation notices and missing font fallbacks.
They do **not** affect rendering.

### Load order

```html
<head>
    <!-- 1. TikZJax fonts CSS -->
    <link rel="stylesheet" href="/js/css/fonts.css">

    <!-- 2. TikZJax engine (synchronous — must not be async/defer) -->
    <script src="/js/output/tikzjax.js"></script>

    <!-- 3. MathJax config (synchronous) -->
    <script>MathJax = { ... };</script>

    <!-- 4. MathJax engine (async is fine) -->
    <script id="MathJax-script" async src="...mathjax..."></script>
</head>
```

---

## 9. Debugging checklist

When a diagram shows a broken image, work through this list:

### Step 1 — Enable console logging
Add `data-show-console="true"` to the script tag. This prints the full
TeX log to the browser console.

### Step 2 — Read the TeX log
The log starts with `This is e-TeX, Version 3.14159265-2.6`.
Look for `!` lines — these are the actual errors.

### Step 3 — Match error to fix

| TeX error | Cause | Fix |
|---|---|---|
| `Can be used only in preamble` | `\usepackage` in script body | Move to `data-add-to-preamble` |
| `I do not know the key '/tikz/X'` | Setup macro not called | Add `\SETUPCMD` to preamble before `\begin{document}` |
| `Missing \begin{document}` | `\begin{document}` not in preamble | Add `\begin{document}` at end of `data-add-to-preamble` |
| `Emergency stop. <*> \end` | `\end{document}` missing in body | Add `\end{document}` after `\end{tikzpicture}` |
| `There's no line here to end` | `\\usepackage` double-backslash | Switch from `data-tex-packages` to `data-add-to-preamble` |
| `Could not find file input.dvi` | Any TeX compile error upstream | Fix the error above this one in the log |

### Step 4 — Check Vercel cache
If the log still shows old code after you push:
- Hard-refresh: `Ctrl+Shift+R` / `Cmd+Shift+R`
- Open in incognito window
- Check Vercel dashboard that the latest deployment is live

---

## 10. Full working example

3D position vector with projection lines:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="/js/css/fonts.css">
    <script src="/js/output/tikzjax.js"></script>
    <script>
        MathJax = {
            tex: { inlineMath: [['$','$']], displayMath: [['$$','$$']] }
        };
    </script>
    <script id="MathJax-script" async
        src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
    </script>
</head>
<body>

<p>The position vector is $\vec{r} = x\hat{i} + y\hat{j} + z\hat{k}$.</p>

<script type="text/tikz"
    data-add-to-preamble="\usepackage{tikz-3dplot}\tdplotsetmaincoords{70}{110}\begin{document}">
    \begin{tikzpicture}[tdplot_main_coords, scale=1.5]
        \draw[thick,->] (0,0,0) -- (2.2,0,0) node[anchor=north east]{$x$};
        \draw[thick,->] (0,0,0) -- (0,2.2,0) node[anchor=north west]{$y$};
        \draw[thick,->] (0,0,0) -- (0,0,2.2) node[anchor=south]{$z$};
        \draw[dashed,gray] (1,1,0) -- (1,1,1);
        \draw[dashed,gray] (1,0,0) -- (1,1,0);
        \draw[dashed,gray] (0,1,0) -- (1,1,0);
        \draw[-stealth,red,ultra thick] (0,0,0) -- (1,1,1)
            node[anchor=west]{$\vec{r}$};
        \node[below] at (0.5,0,0) {\small$x$};
        \node[right] at (0,0.5,0) {\small$y$};
        \node[right] at (0,0,0.5) {\small$z$};
    \end{tikzpicture}
    \end{document}
</script>

</body>
</html>
```

---

## 11. Error dictionary

Quick reference for every error encountered during debugging:

```
\\usepackage (double backslash)
→ Caused by data-tex-packages attribute
→ Fix: use data-add-to-preamble instead

! LaTeX Error: Can be used only in preamble.
→ \usepackage{} is inside the script body
→ Fix: move to data-add-to-preamble

! Package pgfkeys Error: I do not know the key '/tikz/tdplot_main_coords'
→ tikz-3dplot loaded but \tdplotsetmaincoords never called
→ Fix: add \tdplotsetmaincoords{70}{110} to data-add-to-preamble

! LaTeX Error: Missing \begin{document}.
→ \begin{document} not in data-add-to-preamble
→ Fix: append \begin{document} at end of data-add-to-preamble value

! Emergency stop. <*> \end
→ \end{document} missing from script body
→ Fix: add \end{document} after \end{tikzpicture}

! LaTeX Error: There's no line here to end. l.1 \\u sepackage
→ data-tex-packages double-backslash bug
→ Fix: switch to data-add-to-preamble

Error: Could not find file input.dvi
→ TeX compiled with errors, produced no output
→ Fix: read the error ABOVE this line in the console log
```

---

*Documented after live debugging session — April 25, 2026*
*Build: `artisticat1/tikzjax` (output-single-file branch)*
*Deployed on: Vercel + GitHub*
