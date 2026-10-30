# Image Decisions Lab

Build, score and export image classification harnesses for decision models. Every step is transparent, hashed and exportable.

![Import a dataset, score it, find the weak outputs, tune the prompt, re-score, see what changed](docs/demo.gif)

Everything runs in the browser: datasets, prompts, runs, cached answers and the API key live in IndexedDB and
local storage. Model calls go straight from the browser to `openrouter.ai`. There is no server code.

## Workflow

1. **Datasets.** Upload a folder or zip in the Hugging Face ImageFolder layout (below). Each dataset gets a
   content hash over its images, labels and label schema.
2. **Prompt.** Write the system prompt, pick the label to classify, phrase the question and its criteria, and add
   reference images (positive/negative for yes/no labels, a class for class labels).
   **Image views** (bottom of the prompt) decide what the model sees of each image: draw regions on a sample
   training image, then build one or more views from operations applied in order: **crop** (with a margin of
   context), **outline** (a frame drawn just outside an area), **spotlight** (darken everything else) and
   **rotate**. Regions are fractions of the image, so the same crop lands on the same object in every image
   from a fixed camera. Each view is sent as its own image with an optional caption; presets cover "crop to the
   region", "outline it" and "whole image + framed close-up". Reference examples can be edited the same way
   (the crop icon on each example), and **Crop & add** in the image viewer cuts a new example from any training
   image. Edits are stored as operations on the original image, included in the prompt hash, and exported and
   imported with the prompt.
3. **Settings.** Paste an OpenRouter key (checked against `/api/v1/key`, which shows the spending limit) and pick
   a decision model. The key is saved client-side, and never goes anywhere.
4. **Score the training set.** Accuracy, balanced accuracy, the score histogram, precision-recall curves and the
   confusion matrix. Optionally choose (or fit) a threshold to maximize balanced accuracy. Turn on
   **Advanced metrics** in the ⋯ menu for AUROC, cross-validated balanced accuracy (threshold fitted on one half
   of the images, scored on the other) and macro balanced accuracy (one-vs-rest per class with at least 3 images).
5. **Score the test set.**
6. **Compare versions.** Save prompt versions. Easily switch between them to compare results.
7. **Inspect.** Filter images by any label, predicted class, outcome (TP/FP/FN/TN or right/wrong), score range
   (drag across the histogram) or confusion-matrix cell; colour borders by label, prediction or outcome. Open an
   image for its probabilities, raw response, cost and cache key, and add hard training cases to the prompt as
   examples (test-set images are never offered). Merge or exclude classes to see whether a coarser label scores better.
8. **Export experiment.** Export one zip with the prompt (and exact request body), dataset manifests and hashes,
   per-image answers (JSONL and CSV), metrics, PR curves, confusion matrix, histogram, and the charts as SVG.

## Pixel parity

A decision model's answer on a borderline image can flip after a one-level pixel change, so the browser sends
exactly the JPEG a Python/Pillow harness would send, byte for byte. The canonical pipeline:

```python
img = Image.open(path).convert("RGB")     # no EXIF rotation, no colour management, alpha dropped
img.thumbnail((max_side, max_side))       # BICUBIC, reducing_gap=2.0; never upscales
img.save(buf, "JPEG", quality=85)         # baseline, 4:2:0, standard tables, no optimize
```

`scripts/reference_pipeline.py` is that pipeline (`uv run scripts/reference_pipeline.py --max-side 1024 --out sent/
images/*.jpg`); its docstring explains each choice. In the browser, `lib/modelImage.ts` decodes JPEG with libjpeg
compiled to WebAssembly (`@jsquash/jpeg`, loaded on first use), PNG with `fast-png` and uncompressed BMP directly,
then ports Pillow's resize (`lib/pillow.ts`) and libjpeg-turbo's encoder (`lib/jpegEncoder.ts`). Thumbnails in the
UI still use the canvas; they are never sent.

`node scripts/check_parity.mjs` (Node 22.18+, uv) runs both pipelines on every demo image and on generated edge
cases (6000×4000 and 4200×3150 photos, odd sizes, progressive, 4:2:2 and 4:4:4 JPEG, greyscale, RGBA, palette,
1-, 2- and 16-bit PNG, interlaced PNG, BMP, thin strips, a JPEG comment, an EXIF-rotated JPEG) at 512, 1024 and
1280 px, and fails on any byte difference. `e2e/parity.spec.ts` checks the request bodies in Chromium and WebKit.
WebP, GIF, CMYK JPEG and compressed or paletted BMP fall back to the browser's decoder: they are resized and encoded
the same way, but their decoded pixels may differ from Pillow's, and an experiment export marks them
`pixel_exact: false`. The export's `prompt/sent/` holds the exact JPEG sent for each reference example, and
`prompt.json` lists their sha256.

Image views run between the decode and the resize: crop, outline, spotlight and rotate operate on the
full-resolution pixels with integer arithmetic (`lib/ops.ts`), and `reference_pipeline.py` has the same operations
in plain Pillow (`apply_ops`, `view_jpeg`; pass a view as JSON with `--view`). A view with **Enlarge** that ends up
smaller than the image size is resized up with `Image.resize(size, BICUBIC)` to a fixed size (`enlarged_size`)
instead of `thumbnail`. The parity check covers views too (crops with margins, outlines at the edge, spotlight,
rotations before crops, enlarged tiny crops), all byte-identical.

## Dataset format

```
my-dataset/
  metadata.jsonl      {"file_name": "images/0001.jpg", "tube_count": "2", "has_open_tube": false}
  dataset.json        optional: {"name", "description", "schema": [{"key", "type", "classes", "description"}]}
  images/0001.jpg
```

JSON booleans (or true/false, yes/no, 0/1 in `metadata.csv`) make a yes/no label; strings make a class label.
`dataset.json` fixes the class order and declares classes a subset may not contain.

## Demo data

`public/demo` holds 27 training and 21 test photos of cluttered labware from
[LabWare_Items](https://huggingface.co/datasets/ABC-iRobotics/LabWare_Items) (ABC-iRobotics, MIT license).
Training frames come from 6 scenes and test frames from 4 other scenes. The one label, `fifty_ml_tubes`, is the
number of 50 ml conical tubes in view, hand-labelled per photo; frames where a tube is cut off or mostly hidden
were left out. Every 50 ml tube in this dataset is capped (the open-looking ones are self-standing tubes stood on
their caps), so there is no capped/uncapped label.

`seed.json` carries two versions of the prompt (v1: bare question; v2: tube anatomy plus three reference images)
and their cached answers from `perplexity/pplx-decider-v1.2` (the default model), so first-time visitors see results, and the run history
shows the improvement, without a key. To regenerate: `node scripts/build-demo-seed.mjs`, then with `npm run dev`
running, `OPENROUTER_API_KEY=… node scripts/capture-demo-runs.mjs` (scores the demo through the real UI; about a
cent). Bump `DEMO_VERSION` in `lib/demo.ts` so browsers holding an older demo swap it for the new one.
