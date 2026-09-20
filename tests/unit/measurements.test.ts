import { describe, it, expect } from 'vitest'
import { bmi } from '@/lib/measurements'

/**
 * BMI is DERIVED, never stored. A `bmi` column would be a second copy of
 * weight/height that drifts the moment either is corrected, and the index
 * convention's rule 2 would then be asked to index a lie. These tests pin the
 * derivation itself — the only part of the measurements module that needs no
 * database.
 */
describe('bmi', () => {
  it('computes kg / m^2 rounded to one decimal', () => {
    // 70 / 1.75^2 = 22.857…
    expect(bmi(70, 175)).toBe(22.9)
  })

  it('rounds half up at the first decimal', () => {
    // 62.5 / 1.70^2 = 21.6262…  →  21.6 ; 63 / 1.70^2 = 21.799… → 21.8
    expect(bmi(62.5, 170)).toBe(21.6)
    expect(bmi(63, 170)).toBe(21.8)
  })

  it('is null when either measurement is absent', () => {
    expect(bmi(null, 175)).toBeNull()
    expect(bmi(70, null)).toBeNull()
    expect(bmi(null, null)).toBeNull()
  })

  it('is null for a non-positive height rather than Infinity', () => {
    // A 0 would divide to Infinity and a negative to a negative BMI; both would
    // render as a number in the UI. The CHECK constraint rejects these at the
    // DB, but this function is also called on unsaved form input.
    expect(bmi(70, 0)).toBeNull()
    expect(bmi(70, -175)).toBeNull()
  })

  it('is null for a non-positive weight', () => {
    expect(bmi(0, 175)).toBeNull()
    expect(bmi(-70, 175)).toBeNull()
  })
})
