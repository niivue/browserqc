/**
 * Manual quality rating, as in MRIQC's report widget: the same fields, the same JSON keys
 * (so MRIQC's rating tools read it) and the same 10 s minimum before Save unlocks.
 */

// MRIQC's artifact keys and labels, in its order.
const ARTIFACTS = [
  ['head-motion', 'Head motion artifacts'],
  ['eye-spillover', 'Eye spillover through PE axis'],
  ['noneye-spillover', 'Non-eye spillover through PE axis'],
  ['coil-failure', 'Coil failure'],
  ['noise-global', 'Global noise'],
  ['noise-local', 'Local noise'],
  ['em-perturbation', 'EM interference/perturbation'],
  ['wrap-around', 'Problematic FoV prescription / wrap-around'],
  ['ghost-aliasing', 'Aliasing ghosts'],
  ['ghost-other', 'Other ghosts (for example, RF spoiling)'],
  ['inu', 'Intensity non-uniformity (B1 bias)'],
  ['field-variation', 'Temporal B1 field non-uniformity variation'],
  ['processing', 'Processing such as denoising, defacing or resamplings happened'],
  ['uncategorized', 'Other uncategorized artifact(s)'],
] as const
const MIN_RATING_SECONDS = 10 // MRIQC's MINIMUM_RATING_TIME: discourages click-through ratings

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const slider = $<HTMLInputElement>('rating')
const confidence = $<HTMLInputElement>('rateConfidence')
const comments = $<HTMLTextAreaElement>('rateComments')
const artifacts = $('rateArtifacts')
const saveBtn = $<HTMLButtonElement>('rateSave')
const ratingBar = $('ratingBar')
const confidenceBar = $('confidenceBar')
let started = 0 // set by resetRating() once an image is displayed

artifacts.replaceChildren(...ARTIFACTS.map(([name, text]) => {
  const label = document.createElement('label')
  label.append(Object.assign(document.createElement('input'), { type: 'checkbox', name }), text)
  return label
}))

const highlight = (bar: HTMLElement, band: number) =>
  [...bar.children].forEach((li, i) => li.classList.toggle('on', i === band))
// MRIQC's bands: < 1.5 Exclude, < 2.5 Poor, ≤ 3.5 Acceptable, else Excellent; confidence < 2 Doubtful.
const rateBand = (v: number) => (v < 1.5 ? 0 : v < 2.5 ? 1 : v <= 3.5 ? 2 : 3)
const showConfidence = () => highlight(confidenceBar, Number(confidence.value) < 2 ? 0 : 1)

const unlock = () => { if ((Date.now() - started) / 1000 > MIN_RATING_SECONDS) saveBtn.disabled = false }
slider.oninput = () => { highlight(ratingBar, rateBand(Number(slider.value))); unlock() }
confidence.oninput = () => { showConfidence(); unlock() }
comments.oninput = artifacts.onchange = unlock // as MRIQC: any edit unlocks

// A new image: a blank form and a fresh clock.
export function resetRating(): void {
  $<HTMLFormElement>('rateForm').reset()
  highlight(ratingBar, -1) // MRIQC shows no rating band until the slider moves
  showConfidence()
  saveBtn.disabled = true
  started = Date.now()
}

export function readRating(subject: string) {
  return {
    dataset: '<unset>', // as MRIQC without a dataset name
    subject,
    rating: slider.value,
    artifacts: [...artifacts.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.name),
    time_sec: (Date.now() - started) / 1000,
    confidence: confidence.value,
    comments: comments.value,
  }
}
