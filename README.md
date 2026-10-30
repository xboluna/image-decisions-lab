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
3. **Settings.** Paste an OpenRouter key (checked against `/api/v1/key`, which shows the spending limit) and pick
   a decision model. The key is saved client-side, and never goes anywhere.
4. **Score the training set.** Accuracy, balanced accuracy, the score histogram, precision-recall curves and the
   confusion matrix. Optionally choose (or fit) a threshold to maximize balanced accuracy.
5. **Score the test set.**
6. **Compare versions.** Save prompt versions. Easily switch between them to compare results.
7. **Inspect.** Filter images by any label, predicted class, outcome (TP/FP/FN/TN or right/wrong), score range
   (drag across the histogram) or confusion-matrix cell; colour borders by label, prediction or outcome. Open an
   image for its probabilities, raw response, cost and cache key, and add hard training cases to the prompt as
   examples (test-set images are never offered). Merge or exclude classes to see whether a coarser label scores better.
8. **Export experiment.** Export one zip with the prompt (and exact request body), dataset manifests and hashes,
   per-image answers (JSONL and CSV), metrics, PR curves, confusion matrix, histogram, and the charts as SVG.
9. **Import experiment.** ⋯ → Import experiment (or the button on an empty training panel) takes a folder or zip:
   an exported experiment, or any folder with a `prompt.json` and ImageFolder dataset folders (folders named
   train / test / holdout / val get that role). Review what was found, adjust roles, and import it all at once.
   An exported experiment also restores the model's saved answers onto the same dataset version, so its
   results show without scoring again.

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
