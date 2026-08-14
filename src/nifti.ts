/**
 * Minimal NIfTI-1 single-file writer: a typed voxel array + geometry → .nii bytes.
 *
 * ponytail: only the header fields NiiVue needs to load a volume and place it in
 * world space (dims, datatype, pixdim, sform/srow). Not a general writer — we
 * build exactly one thing with it: the air-mask overlay on the RAS grid. (It
 * also wrote the segmentation overlay until the brainchop module started returning
 * a complete NIfTI itself; the label-map intent and the Int16/Float32 branches
 * went with that caller.) Correctness is
 * exercised end-to-end (a malformed header makes NiiVue's addVolume throw, which
 * the e2e smoke's console-error gate catches).
 */

export type NiftiGeom = {
  dims: number[] // NIfTI dim array; indices 1..3 = nx, ny, nz
  pixDims: number[] // indices 0..3 = qfac, dx, dy, dz
  affine: number[][] // 4×4 voxel→mm, row-major (NiiVue hdr.affine)
}

const HDR_SIZE = 348
const VOX_OFFSET = 352 // 348 header + 4-byte extension flag

export function writeNifti(geom: NiftiGeom, img: Uint8Array): Uint8Array {
  const datatype = 2 // DT_UINT8 — the one caller writes a binary air mask
  const bitpix = 8

  const nx = geom.dims[1]
  const ny = geom.dims[2]
  const nz = geom.dims[3]
  const imgBytes = new Uint8Array(img.buffer, img.byteOffset, img.byteLength)
  const out = new Uint8Array(VOX_OFFSET + imgBytes.length)
  const dv = new DataView(out.buffer)
  const LE = true

  dv.setInt32(0, HDR_SIZE, LE) // sizeof_hdr
  dv.setInt16(40, 3, LE) // dim[0] = 3 dimensions
  dv.setInt16(42, nx, LE)
  dv.setInt16(44, ny, LE)
  dv.setInt16(46, nz, LE)
  dv.setInt16(48, 1, LE)
  dv.setInt16(50, 1, LE)
  dv.setInt16(52, 1, LE)
  dv.setInt16(54, 1, LE)
  dv.setInt16(70, datatype, LE)
  dv.setInt16(72, bitpix, LE)
  dv.setFloat32(76, geom.pixDims[0] || 1, LE) // pixdim[0] = qfac
  dv.setFloat32(80, geom.pixDims[1] || 1, LE)
  dv.setFloat32(84, geom.pixDims[2] || 1, LE)
  dv.setFloat32(88, geom.pixDims[3] || 1, LE)
  dv.setFloat32(108, VOX_OFFSET, LE) // vox_offset
  dv.setFloat32(112, 1, LE) // scl_slope
  dv.setFloat32(116, 0, LE) // scl_inter
  out[123] = 2 // xyzt_units = NIFTI_UNITS_MM
  dv.setInt16(252, 0, LE) // qform_code = 0 (rely on sform)
  dv.setInt16(254, 1, LE) // sform_code = 1 (use srow_*)
  const A = geom.affine
  for (let c = 0; c < 4; c++) dv.setFloat32(280 + c * 4, A[0][c], LE) // srow_x
  for (let c = 0; c < 4; c++) dv.setFloat32(296 + c * 4, A[1][c], LE) // srow_y
  for (let c = 0; c < 4; c++) dv.setFloat32(312 + c * 4, A[2][c], LE) // srow_z
  out[344] = 0x6e // 'n'
  out[345] = 0x2b // '+'
  out[346] = 0x31 // '1'
  out[347] = 0 // '\0'  → magic "n+1\0"

  out.set(imgBytes, VOX_OFFSET)
  return out
}
