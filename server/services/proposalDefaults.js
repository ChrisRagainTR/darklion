'use strict';

const TAX_DEFAULT_TIERS = [
  {
    name: 'Tax Subscription',
    subtitle: 'Essential tax management for individuals & businesses',
    price: 250,
    bullets: [
      'Personal & Business Tax Return Preparation',
      'Proactive Tax Strategy & Projections',
      'Quarterly Estimated Tax Planning',
      'Year-Round CPA Support & Consultations',
      'IRS Compliance & Representation',
    ],
    recommended: false,
  },
  {
    name: 'Tax + Bookkeeping',
    subtitle: 'Complete tax & financial record management',
    price: 500,
    bullets: [
      'Monthly Bookkeeping & Reconciliation',
      'Financial Statement Preparation',
      'Cash Flow Monitoring & Analysis',
      'Payroll Tax Compliance & Reporting',
      'Year-End Close & Adjusting Entries',
    ],
    recommended: true,
  },
  {
    name: 'Tax + Bookkeeping + Financial Planning',
    subtitle: 'Full-service tax, bookkeeping & wealth strategy',
    price: 1000,
    bullets: [
      'Comprehensive Financial Plan & Roadmap',
      'Investment Management & Portfolio Oversight',
      'Retirement & Cashflow Planning',
      'Estate & Legacy Planning',
      'Insurance & Risk Assessment',
    ],
    recommended: false,
  },
];

const WEALTH_DEFAULT_TIERS = [
  {
    name: 'Tax & Planning',
    subtitle: 'Comprehensive tax strategy & financial planning',
    price: 299,
    bullets: [
      'Tax Return Preparation & Planning',
      'Proactive Tax Strategy & Projections',
      'Retirement Income Strategies',
      'Tax-Advantaged Distribution Planning',
      'Year-Round Advisory Support',
    ],
    recommended: false,
  },
  {
    name: 'Legacy Blueprint',
    subtitle: 'Full-service financial planning & life oversight',
    price: 599,
    bullets: [
      'Healthcare & Medicaid Planning',
      'Estate & Legacy Planning',
      'Fraud Protection & Tech Safety',
      'Emergency Procedures & Household Vault',
      'Wellness Checks & Ongoing Support',
    ],
    recommended: true,
  },
  {
    name: 'Investment Management',
    subtitle: 'Discretionary portfolio management + full planning',
    price: 0,
    bullets: [
      'Customized Investment Portfolio',
      'Ongoing Portfolio Monitoring & Rebalancing',
      'Tax-Efficient Investment Strategies',
      'Quarterly Performance Reviews',
      'Dedicated Portfolio Manager',
    ],
    recommended: false,
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDefaultProposalTiers(engagementType = 'tax') {
  return clone(engagementType === 'wealth' ? WEALTH_DEFAULT_TIERS : TAX_DEFAULT_TIERS);
}

function normalizeProposalTiers({
  engagementType = 'tax',
  tiers = null,
  recommendedTierIndex = null,
  recommendedTierIndices = null,
} = {}) {
  const normalized = Array.isArray(tiers) && tiers.length
    ? clone(tiers)
    : getDefaultProposalTiers(engagementType);

  const recommended = Array.isArray(recommendedTierIndices)
    ? recommendedTierIndices.map(i => parseInt(i, 10)).filter(Number.isInteger)
    : (recommendedTierIndex !== null && recommendedTierIndex !== undefined
      ? [parseInt(recommendedTierIndex, 10)].filter(Number.isInteger)
      : []);

  if (recommended.length) {
    normalized.forEach((tier, index) => {
      tier.recommended = engagementType === 'wealth'
        ? recommended.includes(index)
        : index === recommended[0];
    });
  } else if (!normalized.some(tier => tier.recommended)) {
    const fallbackIndex = engagementType === 'wealth' ? 1 : 1;
    if (normalized[fallbackIndex]) normalized[fallbackIndex].recommended = true;
  }

  return normalized.map(tier => ({
    name: tier.name || '',
    subtitle: tier.subtitle || '',
    price: Number.isFinite(Number(tier.price)) ? Number(tier.price) : 0,
    bullets: Array.isArray(tier.bullets) ? tier.bullets : [],
    recommended: !!tier.recommended,
  }));
}

module.exports = {
  TAX_DEFAULT_TIERS,
  WEALTH_DEFAULT_TIERS,
  getDefaultProposalTiers,
  normalizeProposalTiers,
};
