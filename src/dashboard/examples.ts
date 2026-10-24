/**
 * The dashboard's example gallery: Crystal Ball's own shipped example models
 * (copied into examples/crystal-ball/ by tools/copy-cb-examples.sh), with the
 * run settings Crystal Ball's documentation uses and, where the User's Guide
 * prints a result, that published result so the dashboard can show the match.
 *
 * Oracle's workbooks aren't published with this project, so the two tutorials
 * also have the project's own copy of their workbook (examples/, built by
 * tools/make_examples.py) and the model Crystal Ball saved in Oracle's copy,
 * written out here; a build without Oracle's files runs those.
 */

import { Assumption, Forecast, SamplingMethod } from '../engine/model';

export interface PublishedResult {
  /** Where the numbers come from. */
  source: string;
  trials: number;
  /** Statistic name → Crystal Ball's displayed value, and its decimals. */
  stats?: Partial<Record<'mean' | 'median' | 'stdDev' | 'variance' | 'skewness' | 'kurtosis' | 'coeffOfVariability' | 'min' | 'max' | 'meanStdError', [number, number]>>;
  /** Percentile (0–100) → displayed value, with one decimals setting for all. */
  percentiles?: { digits: number; values: [number, number][] };
  /** Certainty of [low, high] in %, two decimals. */
  certainty?: { low: number; high: number; value: number };
}

export interface Example {
  id: string;
  title: string;
  file: string;
  blurb: string;
  /** What it exercises, shown as tags. */
  features: string[];
  trials: number;
  sampling?: SamplingMethod;
  /** Assumptions a tutorial asks the user to add to the shipped workbook. */
  extraAssumptions?: Assumption[];
  extraForecasts?: Forecast[];
  published?: PublishedResult[];
  /** Initial certainty range for the forecast chart. */
  certaintyLow?: number;
  /** The project's own copy of the workbook (in examples/) and the model Crystal Ball saved in Oracle's. */
  own?: { file: string; assumptions: Assumption[]; forecasts: Forecast[] };
}

export const EXAMPLES: Example[] = [
  {
    id: 'futura',
    title: 'Futura Apartments',
    file: 'Futura Apartments.xlsx',
    blurb: 'Tutorial 1: will buying an apartment complex turn a profit? Rental units and monthly expenses are uncertain.',
    features: ['Discrete Uniform', 'Normal', 'Tutorial'],
    trials: 1000,
    certaintyLow: 0,
    own: {
      file: 'futura_apartments.xlsx',
      assumptions: [
        { id: 'fa-expenses', cell: 'Model!C7', name: 'Monthly Expenses', type: 'normal', params: { mean: 15000, stdev: 1000 } },
        { id: 'fa-units', cell: 'Model!C5', name: 'Number of Rental Units', type: 'discreteuniform', params: { min: 30, max: 40 } },
      ],
      forecasts: [{ id: 'fa-profit', cell: 'Model!C9', name: 'Profit or Loss' }],
    },
    published: [
      {
        source: "User's Guide figure futuraprofitfcmc (1,000 trials, seed 999)",
        trials: 1000,
        certainty: { low: 0, high: Infinity, value: 90.09 },
      },
      {
        source: "User's Guide figure futurasplitmulti (5,000 trials, seed 999)",
        trials: 5000,
        stats: {
          mean: [2473.72, 2],
          median: [2486.58, 2],
          stdDev: [1850.66, 2],
          variance: [3424956.14, 2],
          skewness: [0.0053, 4],
          kurtosis: [2.4, 2],
          coeffOfVariability: [0.7481, 4],
          min: [-2732.96, 2],
          max: [8275.85, 2],
          meanStdError: [26.17, 2],
        },
        percentiles: {
          digits: 2,
          values: [
            [0, -2732.96], [10, 12.51], [20, 792.64], [30, 1374.05], [40, 1943.86], [50, 2486.48],
            [60, 2995.3], [70, 3557.3], [80, 4189.77], [90, 4946.92], [100, 8275.85],
          ],
        },
      },
    ],
  },
  {
    id: 'vision',
    title: 'Vision Research',
    file: 'Vision Research.xlsx',
    blurb:
      'Tutorial 2: should ClearView, a new eye drug, go to market? Includes the three assumptions and the Net Profit forecast the tutorial adds.',
    features: ['Binomial', 'Custom', 'Truncated Normal', 'Tutorial'],
    trials: 5000,
    certaintyLow: 0,
    extraAssumptions: [
      { id: 'vr-testing', cell: 'Model!C5', name: 'Testing Costs', type: 'uniform', params: { min: 3, max: 5 } },
      {
        id: 'vr-growth',
        cell: 'Model!C15',
        name: 'Growth Rate',
        type: 'custom',
        params: {},
        custom: [
          { min: 0, max: 0.05, weight: 0.75 },
          { min: -0.15, max: -0.05, weight: 0.25 },
        ],
      },
      {
        id: 'vr-penetration',
        cell: 'Model!C19',
        name: 'Market Penetration',
        type: 'normal',
        params: { mean: 0.08, stdev: 0.02 },
        truncMin: 0.05,
      },
    ],
    extraForecasts: [{ id: 'vr-net', cell: 'Model!C23', name: 'Net Profit', units: '$MM' }],
    own: {
      file: 'vision_research.xlsx',
      assumptions: [
        { id: 'vr-marketing', cell: 'Model!C6', name: 'Marketing Costs', type: 'triangular', params: { min: 12, likely: 16, max: 18 } },
        { id: 'vr-cured', cell: 'Model!C10', name: 'Patients Cured', type: 'binomial', params: { trials: 100, probability: 0.25 } },
      ],
      forecasts: [],
    },
    published: [
      {
        source: "User's Guide figures netprofitstats & netprofitpctiles (5,000 trials, seed 999)",
        trials: 5000,
        stats: {
          mean: [7.9, 1],
          median: [8.4, 1],
          stdDev: [11.1, 1],
          variance: [122.9, 1],
          skewness: [-0.1734, 4],
          kurtosis: [2.86, 2],
          coeffOfVariability: [1.41, 2],
          min: [-15.0, 1],
          max: [44.1, 1],
          meanStdError: [0.2, 1],
        },
        percentiles: {
          digits: 1,
          values: [
            [0, -15.0], [10, -7.3], [20, -0.5], [30, 2.6], [40, 5.6], [50, 8.4],
            [60, 11.0], [70, 13.6], [80, 17.1], [90, 21.6], [100, 44.1],
          ],
        },
      },
    ],
  },
  {
    id: 'toxic',
    title: 'Toxic Waste Site',
    file: 'Toxic Waste Site.xlsx',
    blurb: 'Cancer risk from a contaminated water supply, compared with the EPA threshold.',
    features: ['Lognormal', 'Normal', 'Triangular'],
    trials: 1000,
  },
  {
    id: 'oil',
    title: 'Oil Field Development',
    file: 'Oil Field Development.xlsx',
    blurb: 'Net present value of developing an oil field with uncertain reserves and recovery.',
    features: ['Lognormal', 'Normal', 'Decision variables'],
    trials: 1000,
    certaintyLow: 0,
  },
  {
    id: 'loan',
    title: 'Loan Process',
    file: 'Loan Process.xlsx',
    blurb: 'Cycle time of a loan application through verification, appraisal and underwriting.',
    features: ['Custom ranges', 'Lognormal', 'Uniform'],
    trials: 1000,
  },
  {
    id: 'multizone',
    title: 'Multi-Zone Reserves',
    file: 'Multi-Zone Reserves.xlsx',
    blurb: 'Recoverable oil across three zones whose area and thickness are correlated through a worksheet matrix.',
    features: ['Correlation matrix', '18 assumptions'],
    trials: 1000,
  },
  {
    id: 'portfolio',
    title: 'Portfolio Revisited',
    file: 'Portfolio Revisited.xlsx',
    blurb: 'Return and risk of a four-asset portfolio with correlated asset returns.',
    features: ['Correlations', 'Normal', 'Two forecasts'],
    trials: 1000,
  },
  {
    id: 'groundwater',
    title: 'Groundwater Cleanup',
    file: 'Groundwater Cleanup.xlsx',
    blurb: 'Cost of cleaning up contaminated groundwater under uncertain site parameters.',
    features: ['14 assumptions', 'Mixed distributions'],
    trials: 1000,
  },
  {
    id: 'project-selection',
    title: 'Project Selection',
    file: 'Project Selection.xlsx',
    blurb: 'Which R&D projects to fund, with success/failure modelled as one-trial binomials.',
    features: ['Binomial', 'Truncated Lognormal'],
    trials: 1000,
  },
  {
    id: 'reliability',
    title: 'Reliability',
    file: 'Reliability.xlsx',
    blurb: 'Time to failure of a system of components, three reliability forecasts.',
    features: ['Weibull', 'Normal'],
    trials: 1000,
  },
  {
    id: 'tolerance',
    title: 'Tolerance Analysis',
    file: 'Tolerance Analysis.xlsx',
    blurb: 'Stack-up of manufacturing tolerances across an assembly.',
    features: ['Normal', 'Four forecasts'],
    trials: 1000,
  },
  {
    id: 'inventory',
    title: 'Inventory System',
    file: 'Inventory System.xlsx',
    blurb: 'A year of weekly Poisson demand drives annual inventory costs.',
    features: ['52 Poisson assumptions'],
    trials: 1000,
  },
  {
    id: 'dcf',
    title: 'DCF Analysis',
    file: 'DCF Analysis.xlsx',
    blurb: 'Discounted cash-flow valuation with uncertain growth and margins.',
    features: ['Normal', 'Triangular', 'Seven forecasts'],
    trials: 1000,
  },
  {
    id: 'product-launch',
    title: 'Product Launch',
    file: 'Product Launch.xlsm',
    blurb:
      'Decision tree and discounted cash flow for a new product. Draws from Crystal Ball’s in-cell CB.Triangular and CB.Binomial functions; its forecasts carry precision targets.',
    features: ['CB.Triangular / CB.Binomial', 'Lognormal', '46 assumptions', 'Precision targets'],
    trials: 1000,
  },
  {
    id: 'facilities',
    title: 'Location of Facilities',
    file: 'Location of Facilities - Distribution Center.xlsx',
    blurb:
      'Total cost of a distribution-center network with 163 assumptions. Its forecast asks for the mean within ±4% at 95% confidence, so precision control ends the run early.',
    features: ['163 assumptions', 'Precision control'],
    trials: 1000,
  },
  {
    id: 'piston',
    title: 'Piston Displacement',
    file: 'Piston Displacement.xlsx',
    blurb: 'Engine displacement from three toleranced dimensions; the sheet reports forecast statistics with CB.GetForeStatFN.',
    features: ['Normal', 'CB.GetForeStatFN'],
    trials: 1000,
  },
  {
    id: 'manufacturing',
    title: 'Manufacturing Supply Chain',
    file: 'Manufacturing Supply Chain.xlsx',
    blurb: 'Process efficiency and cost of poor quality across procurement, manufacturing and distribution.',
    features: ['Triangular', 'Six forecasts'],
    trials: 1000,
  },
  {
    id: 'roi',
    title: 'Return on Investment',
    file: 'Return on Investment.xlsx',
    blurb: 'Payback period and NPV of a project from 25 uncertain yearly revenues and costs.',
    features: ['Triangular', 'Payback & NPV'],
    trials: 1000,
  },
  {
    id: 'critical-path',
    title: 'Critical Path',
    file: 'Critical Path.xlsx',
    blurb: 'Project schedule: 20 uncertain task durations, 21 forecasts.',
    features: ['Triangular', 'Many forecasts'],
    trials: 1000,
  },
  {
    id: 'cell-phone',
    title: 'Cell Phone',
    file: 'Cell Phone.xlsx',
    blurb: 'A small design-for-six-sigma model of a handset component.',
    features: ['Normal', 'Triangular'],
    trials: 1000,
  },
  {
    id: 'hotel',
    title: 'Hotel Design',
    file: 'Hotel Design.xlsx',
    blurb: 'Revenue of a hotel design under uncertain demand.',
    features: ['Uniform', 'Decision variables'],
    trials: 1000,
  },
];
