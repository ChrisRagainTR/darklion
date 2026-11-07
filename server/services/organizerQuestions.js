const ORGANIZER_QUESTIONS = [
  { id: 'q1', screen: 2, section: 'Household', text: 'Did your marital status change during the year?', detailRequiredOnYes: true, placeholder: "Tell us briefly what changed (e.g., 'Got married on June 15' or 'Divorce finalized in August')", documents: ['Marriage certificate', 'Divorce decree', 'Death certificate'] },
  { id: 'q2', screen: 2, section: 'Household', text: 'Did any of your dependents change?', detailRequiredOnYes: true, placeholder: 'Tell us about the change. If you added a new dependent, include their name, date of birth, and SSN.', documents: ['New dependent SSN/DOB docs'] },
  { id: 'q3', screen: 2, section: 'Household', text: 'Did you move to a different state or change your address?', detailRequiredOnYes: true, placeholder: "What's your new address and when did you move?", documents: ['W-2s for all states'] },
  { id: 'q4', screen: 3, section: 'Income Changes', text: 'Did you change jobs, employers, or receive income from a new source?', detailRequiredOnYes: true, placeholder: "Tell us about the new income (e.g., 'New job at XYZ Inc.' or '1099-NEC for consulting' or 'Uber side gig')", documents: ['New W-2', '1099-NEC', '1099-K', 'P&L'] },
  { id: 'q5', screen: 3, section: 'Income Changes', text: 'Did you sell any stocks, bonds, cryptocurrency, or other investments?', detailRequiredOnYes: true, placeholder: "Tell us what you sold and approximately when (e.g., 'Sold 50 shares of Apple in April — have 1099-B')", documents: ['1099-B', 'Brokerage statements'] },
  { id: 'q6', screen: 3, section: 'Income Changes', text: 'Did you take any distributions from retirement accounts (401(k), IRA, pension)?', detailRequiredOnYes: true, placeholder: 'Tell us about the distribution. If any withdrawals were before age 59½, please note that here.', documents: ['1099-R', 'Exception docs if early'] },
  { id: 'q7', screen: 3, section: 'Income Changes', text: 'Do you have any rental property income or expenses? Did you rent out your home (e.g., Airbnb)?', detailRequiredOnYes: true, placeholder: "Tell us about the rental activity (e.g., 'Bought rental house at 123 Main St in May' or 'Airbnb in spare room June-August')", documents: ['Schedule E worksheet', 'Rental expense records'] },
  { id: 'q8', screen: 3, section: 'Income Changes', text: 'Did you receive any foreign income or have foreign bank accounts?', detailRequiredOnYes: true, placeholder: "Tell us about the foreign income or accounts (e.g., 'Consulting client in Canada paid $5K' or 'Joint bank account in UK')", documents: ['Foreign income docs', 'FBAR info'] },
  { id: 'q9', screen: 4, section: 'Deductions & Health', text: 'Did you make any IRA, HSA, or retirement contributions?', detailRequiredOnYes: true, placeholder: "Tell us about the contributions (e.g., '$6,500 to traditional IRA in March')", documents: ['5498', '5498-SA'] },
  { id: 'q10', screen: 4, section: 'Deductions & Health', text: 'Did you pay any student loan interest or education expenses (tuition, fees)?', detailRequiredOnYes: true, placeholder: "Tell us about the education expenses (e.g., '$2,400 student loan interest' or 'Daughter\'s tuition at State U — $8,500')", documents: ['1098-E', '1098-T'] },
  { id: 'q11', screen: 4, section: 'Deductions & Health', text: 'Did you make any significant charitable contributions (cash over $300, non-cash, or over $5,000)?', detailRequiredOnYes: true, placeholder: "Tell us about the charitable contributions (e.g., '$1,200 to St. Mary\'s Church' or 'Donated car to charity')", documents: ['Donation receipts', 'Appraisal if >$5K'] },
  { id: 'q12', screen: 4, section: 'Deductions & Health', text: 'Did you pay for child care or dependent care?', detailRequiredOnYes: true, placeholder: "Tell us about the child care (e.g., 'ABC Daycare — $8,200 — EIN 12-3456789')", documents: ['Provider info', 'Payment records'] },
  { id: 'q13', screen: 4, section: 'Deductions & Health', text: 'Did you receive health insurance through the Marketplace (Healthcare.gov)?', detailRequiredOnYes: true, placeholder: "Tell us about your Marketplace coverage (e.g., 'Have 1095-A — income was higher than estimated')", documents: ['1095-A'] },
  { id: 'q14', screen: 5, section: 'Final Items', text: 'Did you receive any IRS or state tax notices after we filed last year?', detailRequiredOnYes: true, placeholder: "Tell us about the notice (e.g., 'CP2000 about missing 1099-NEC — have the letter')", documents: ['Copy of notice(s)'] },
  { id: 'q15', screen: 5, section: 'Final Items', text: 'Did you make estimated tax payments for this year?', detailRequiredOnYes: true, placeholder: "Tell us about the estimated payments (e.g., 'Paid $1,200 on 4/15 and $1,200 on 6/15')", documents: ['1040-ES vouchers', 'Bank records'] },
  { id: 'q16', screen: 5, section: 'Final Items', text: 'Has your bank account or direct deposit information changed?', detailRequiredOnYes: true, placeholder: "Tell us about the new account (e.g., 'New checking at Chase — routing 021000021 — account ending in 4567')", documents: ['New routing/account numbers'] },
  { id: 'q17', screen: 5, section: 'Final Items', text: "Are there any special circumstances, concerns, or questions about this year's tax situation we should know about?", type: 'textarea', required: false, placeholder: "Anything else we should know? (e.g., 'Thinking about buying a rental next year — want to discuss')", documents: [] },
];

function normalizeAnswers(raw = {}) {
  const answers = raw && typeof raw === 'object' ? raw : {};
  const normalized = {};
  for (const q of ORGANIZER_QUESTIONS) {
    const val = answers[q.id];
    if (q.id === 'q17') {
      normalized[q.id] = { details: typeof val === 'string' ? val : (val?.details || '') };
    } else if (typeof val === 'boolean') {
      normalized[q.id] = { answer: val, details: '' };
    } else if (val && typeof val === 'object') {
      normalized[q.id] = { answer: typeof val.answer === 'boolean' ? val.answer : null, details: val.details || '' };
    } else {
      normalized[q.id] = { answer: null, details: '' };
    }
  }
  return normalized;
}

function validateOrganizerAnswers(raw = {}) {
  const answers = normalizeAnswers(raw);
  const errors = [];
  for (const q of ORGANIZER_QUESTIONS) {
    const value = answers[q.id];
    if (q.id === 'q17') continue;
    if (typeof value.answer !== 'boolean') errors.push({ question_id: q.id, error: 'Answer Yes or No' });
    if (value.answer === true && q.detailRequiredOnYes && !String(value.details || '').trim()) {
      errors.push({ question_id: q.id, error: 'Details required for Yes answer' });
    }
  }
  return { ok: errors.length === 0, errors, answers };
}

function triggeredDocumentsForAnswers(raw = {}) {
  const answers = normalizeAnswers(raw);
  const docs = [];
  for (const q of ORGANIZER_QUESTIONS) {
    if (q.id === 'q17') continue;
    if (answers[q.id]?.answer === true) {
      (q.documents || []).forEach((name, idx) => docs.push({ questionId: q.id, displayName: name, order: idx }));
    }
  }
  return docs;
}

module.exports = { ORGANIZER_QUESTIONS, normalizeAnswers, validateOrganizerAnswers, triggeredDocumentsForAnswers };
