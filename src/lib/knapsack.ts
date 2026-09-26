/* Budget allocation — the greedy knapsack behind /budget.
 *
 * A true 0/1 knapsack over 1100 segments and a 5-crore budget is solvable, but
 * greedy-by-density is what a public works office actually does, it is stable as
 * the slider moves (one more rupee never drops a segment that was already in),
 * and the ordering is explainable to a non-technical audience. Those matter
 * more here than the last percent of optimality. */

export interface Candidate {
  id: number
  /** Risk removed by fixing this segment. */
  value: number
  costInr: number
}

export interface Allocation {
  chosen: number[]
  totalCostInr: number
  totalValue: number
}

export function greedyAllocate(
  candidates: Candidate[],
  budgetInr: number,
): Allocation {
  const ranked = [...candidates]
    .filter((c) => c.costInr > 0 && c.value > 0)
    .sort((a, b) => b.value / b.costInr - a.value / a.costInr)

  const chosen: number[] = []
  let totalCostInr = 0
  let totalValue = 0

  for (const candidate of ranked) {
    if (totalCostInr + candidate.costInr > budgetInr) continue
    chosen.push(candidate.id)
    totalCostInr += candidate.costInr
    totalValue += candidate.value
  }

  return { chosen, totalCostInr, totalValue }
}
