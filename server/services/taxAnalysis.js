'use strict';
const { completeText } = require('./managedInference');
const { applyVerifiedFacts } = require('./taxFactExtractor');

const EXTRACTION_PROMPT = `You are a tax return data extraction expert. Analyze the following text extracted from a federal tax return (Form 1040/1040-SR) and workpapers. Extract all data needed for a client-facing tax summary report.

Return ONLY valid JSON with this exact structure (no markdown, no code fences):

{
  "client": {
    "names": "First & Last names of both taxpayers (or single)",
    "filing_status": "e.g., Married Filing Jointly",
    "tax_year": "2025",
    "form_type": "1040 or 1040-SR",
    "preparer": "Preparer name and credentials",
    "date_prepared": "Date prepared",
    "address": "Full address"
  },
  "income_sources": [
    { "source": "Description of income source", "amount": 12345, "note": "optional note" }
  ],
  "total_income": 52974,
  "adjusted_gross_income": 52974,
  "deductions": [
    { "name": "Standard Deduction", "amount": 34700 }
  ],
  "total_deductions": 46700,
  "taxable_income": 6274,
  "tax_before_credits": 323,
  "credits": 0,
  "total_tax": 323,
  "total_payments": 1695,
  "refund_or_owed_amount": 1372,
  "is_refund": true,
  "effective_rate": 0.6,
  "marginal_bracket": 10,
  "savings_highlights": [
    { "amount": "$12,000", "title": "Short title", "description": "1-2 sentence explanation" }
  ],
  "strategies": [
    { "title": "Strategy name", "category": "personal", "potential_savings": "$5,000", "description": "1-2 sentences" }
  ],
  "carryovers": [{ "item": "Capital loss carryover", "amount": "$21,103" }],
  "estimated_payments_required": true,
  "federal_estimated_payments": [
    { "quarter": "1st", "due_date": "April 15, 2026", "amount": "$18,570", "method": "Mail a check" },
    { "quarter": "2nd", "due_date": "June 15, 2026", "amount": "$18,570", "method": "Mail a check" },
    { "quarter": "3rd", "due_date": "September 15, 2026", "amount": "$18,570", "method": "Mail a check" },
    { "quarter": "4th", "due_date": "January 15, 2027", "amount": "$18,570", "method": "Mail a check" }
  ],
  "state_estimated_payments": [
    { "state": "Georgia", "quarter": "1st", "due_date": "April 15, 2026", "amount": "$2,600", "method": "Mail a check" }
  ],
  "refund_method": "Direct deposit or check",
  "key_stats": { "capital_loss_carryover": 21103, "qbi_loss_carryforward": 13200 },
  "social_security": { "total_benefits": 82560, "taxable_portion": 26333, "percent_taxable": 32 },
  "prior_year_comparison": {
    "prior_tax_year": "2024",
    "current_tax_year": "2025",
    "items": [
      { "label": "Wages, salaries, tips", "prior_year": 13500, "current_year": 9200, "difference": -4300 },
      { "label": "Total Income", "prior_year": 120243, "current_year": 170032, "difference": 49789 },
      { "label": "Total Tax", "prior_year": 5962, "current_year": 17932, "difference": 11970 },
      { "label": "Effective tax rate (%)", "prior_year": 12.27, "current_year": 16.65, "difference": 4.38 }
    ],
    "highlights": [
      { "title": "S-Corp income up $37,544", "description": "Income rose significantly.", "direction": "increase" }
    ]
  }
}

IMPORTANT GUIDELINES:
- All dollar amounts should be numbers (not strings) except in savings_highlights and strategies
- Include up to 5 savings highlights supported by the source facts. Do not invent savings or attribute them to the firm without evidence
- Be specific with numbers - cite actual amounts from the return
- If something is unclear, make reasonable inferences from the data

CRITICAL — STRATEGIES (THIS IS THE MOST IMPORTANT SECTION):
Include 5-8 forward-looking strategies for the next tax year. Each strategy MUST include title, category, potential_savings, and description.

Here is the COMPLETE STRATEGY LIBRARY — recommend ALL that apply:

=== PERSONAL STRATEGIES ===

1. 401(k) Maximization (Taxpayer) — If W-2 income present, check if 401(k) contributions are below the max ($23,500 for 2025, $24,500 for 2026). Recommend maxing out. Include catch-up ($7,500) if age 50+.

2. 401(k) Maximization (Spouse) — Same for spouse if MFJ with two W-2 earners.

3. Roth Conversion Opportunity — If AGI is relatively low or transitional year. Especially if marginal bracket is 22% or below.

4. Backdoor Roth IRA — If AGI too high for direct Roth (>$161K single / >$240K MFJ). Contribute $7,000 ($8,000 if 50+) to traditional IRA then convert.

5. Mega Backdoor Roth — If 401(k) allows after-tax contributions. Contribute up to $70,000 annual 415(c) limit.

6. Traditional & Roth IRA Contributions (Taxpayer) — If no IRA contributions visible and AGI qualifies. Max $7,000 ($8,000 if 50+).

7. Traditional & Roth IRA Contributions (Spouse) — Same for spouse if MFJ.

8. Health Savings Account (HSA) — If HDHP eligible. Max $4,300 single / $8,550 family for 2025. Triple tax benefit.

9. Charitable Contributions / Donor-Advised Fund — If itemizing or near threshold. Bunching strategy or DAF. If age 70.5+, recommend QCDs up to $105,000/year.

10. Education Tax Credits — If dependents in college. American Opportunity Credit $2,500, Lifetime Learning $2,000.

11. Child and Dependent Care Tax Credit — If dependents and both spouses work. Up to $3,000/$6,000.

12. Clean Vehicle Tax Credit — Up to $7,500 new EVs, $4,000 used. Mention if purchasing vehicle.

13. Residential Energy Credits — Up to $2,000 for solar, heat pumps, etc. If homeowner.

14. Qualified Charitable Distributions (QCDs) — If age 70.5+ with IRA. Up to $105,000/year direct from IRA.

=== BUSINESS STRATEGIES ===

15. Employing Children — If business + dependents under 18. Up to ~$15,000/child deductible, child pays little tax. No FICA if under 18 sole prop/partnership.

16. Defined Benefit Plan / Cash Balance Plan — If self-employed/owner with high income. Up to $280,000/year fully deductible. Best for high earners age 45+.

17. SEP IRA Contribution — If self-employed. Up to 25% of net SE income, max $70,000 for 2025.

18. SIMPLE IRA — If small business. Up to $16,500 for 2025, $3,500 catch-up if 50+.

19. 14-Day Home Rental (Augusta Rule) — If homeowner + business. Rent home to business up to 14 days, up to ~$8,000 tax-free rental income, deductible to business.

20. Accountable Plan — If business owner. Reimburse personal/business expenses (cell, internet, mileage, meals) ~$6,500/year tax-free.

21. S-Corp 2% Shareholder Health Insurance — If S-corp owner. Properly structure $10,300+ premium as deductible business expense on W-2.

22. Expense Acceleration — If higher income expected next year, accelerate deductible expenses. Target ~8% of total business expenses.

23. Income Deferment — If lower income expected next year, defer invoicing. Target ~8% of business revenue.

24. Home Office Deduction — If works from home. Simplified: $5/sq ft up to 300 sq ft = $1,500.

STRATEGY SELECTION RULES:
- ALWAYS recommend at least 5 strategies, ideally 6-8
- W-2 income → 401(k), IRA, HSA, Roth strategies
- Business/SE income → ALL business strategies
- Dependents → employing children, child care, education credits
- Low bracket → Roth conversions
- High income → defined benefit, backdoor Roth, mega backdoor
- Age 50+ → catch-up contributions everywhere applicable
- Age 70.5+ → QCDs
- Be specific to THIS client — reference their actual numbers

CRITICAL — ESTIMATED PAYMENTS:
- Search entire document for estimated payment schedules, vouchers, 1040-ES, ES Vouchers
- Extract EXACT dollar amounts shown
- If federal payments found: populate federal_estimated_payments with quarter, due_date, amount, method
- If state payments found: populate state_estimated_payments with state, quarter, due_date, amount
- If none found: set estimated_payments_required: false, leave arrays empty []
- NEVER generate empty amount fields

CRITICAL — YEAR-OVER-YEAR COMPARISON:
- Search for page titled "TAX RETURN COMPARISON"
- If found: populate prior_year_comparison with the two most recent years
- Extract these line items: Wages, Taxable interest & dividends, Business income, Capital gains, Pensions & IRA distributions, Rent & royalty income, S-Corp/Partnership income, Social Security (taxable), Other income, Total Income, Total AGI, Total deductions, Taxable Income, Total Tax, Withholdings, Estimated tax payments, Refund, Balance Due, Effective tax rate (%), Marginal tax rate (%)
- difference = current_year minus prior_year
- highlights: 3-4 most notable changes
- If NO comparison page: set prior_year_comparison to null`;

async function analyzeTaxReturn(pdfText, verifiedFactExtraction = null, firmId) {

  const maxChars = 180000;
  const inputText = pdfText.length > maxChars
    ? pdfText.substring(0, maxChars) + '\n\n[TEXT TRUNCATED]'
    : pdfText;

  const verifiedFactPacket = verifiedFactExtraction
    ? `\n\n--- VERIFIED DETERMINISTIC FACTS ---\n\n${JSON.stringify(verifiedFactExtraction, null, 2)}\n\nUse these verified facts as the source of truth for core Form 1040 fields. Do not override AGI, taxable income, total tax, total payments, refund/balance due, filing status, or tax year when a verified fact is present.\n\n--- END VERIFIED FACTS ---`
    : '';

  const content = await completeText({firmId,feature:'tax-analysis',maxTokens:4096,
    prompt: `${EXTRACTION_PROMPT}${verifiedFactPacket}\n\n--- BEGIN TAX RETURN TEXT ---\n\n${inputText}\n\n--- END TAX RETURN TEXT ---`,
  });
  if (!content) throw new Error('Empty AI response');

  const cleaned = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return applyVerifiedFacts(JSON.parse(cleaned), verifiedFactExtraction);
}

module.exports = { analyzeTaxReturn };
