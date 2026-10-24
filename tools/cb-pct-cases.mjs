// Percentile-parameter cases for the Crystal Ball oracle (harness/dist eval):
// each distribution with one or two of its parameters entered as percentiles.
//   node tools/cb-pct-cases.mjs cases > cases.json
//   node tools/cb-pct-cases.mjs merge cases.json answers.json > fixture.json
import { readFileSync } from 'node:fs';

const P = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
const cases = [
  'Normal,10%=80,90%=120', 'Normal,Mean=100,90%=120', 'Normal,10%=80,StdDev=15', 'Normal,25%=90,99%=150',
  'Uniform,10%=2,90%=8', 'Uniform,Min=0,90%=8', 'Uniform,10%=2,Max=10',
  'Logistic,10%=80,90%=120', 'Logistic,Mean=100,90%=120', 'Logistic,10%=80,Scale=5',
  'MinExtreme,10%=80,90%=120', 'MinExtreme,Likeliest=100,90%=120', 'MinExtreme,10%=80,Scale=5',
  'MaxExtreme,10%=80,90%=120', 'MaxExtreme,Likeliest=100,90%=120', 'MaxExtreme,10%=80,Scale=5',
  'Student,10%=80,90%=120,Degrees=5', 'Student,Midpoint=100,90%=120,Degrees=5', 'Student,10%=80,Scale=5,Degrees=5',
  'LogNormal,10%=80,90%=120,Location=0', 'LogNormal,Mean=100,90%=120,Location=0', 'LogNormal,10%=80,StdDev=15,Location=0',
  'LogNormal,10%=80,90%=120,Location=10',
  'Gamma,Location=0,10%=2,90%=9', 'Gamma,Location=0,Scale=1,90%=9', 'Gamma,Location=0,10%=2,Shape=3', 'Gamma,10%=2,Scale=1,Shape=3',
  'Weibull,Location=0,10%=2,90%=9', 'Weibull,Location=0,Scale=4,90%=9', 'Weibull,Location=0,10%=2,Shape=3', 'Weibull,10%=2,Scale=4,Shape=3',
  'Triangular,10%=2,Likeliest=5,90%=9', 'Triangular,Min=0,Likeliest=5,90%=9', 'Triangular,10%=2,Likeliest=5,Max=10', 'Triangular,Min=0,50%=4,Max=10',
  'BetaPERT,10%=2,Likeliest=5,90%=9', 'BetaPERT,Min=0,Likeliest=5,90%=9', 'BetaPERT,10%=2,Likeliest=5,Max=10',
  'Beta,Min=0,Max=1,10%=0.2,90%=0.7', 'Beta,Min=0,Max=1,Alpha=2,90%=0.7', 'Beta,Min=0,Max=1,10%=0.2,Beta=3',
  'Exponential,90%=3', 'Pareto,Location=1,90%=5', 'Pareto,10%=1.2,Shape=2',
  'DPoisson,90%=8',
  // Wider coverage of the Nelder–Mead fits and Crystal Ball's slot rules.
  'Triangular,5%=1,Likeliest=4,95%=12', 'Triangular,20%=3,50%=5,80%=8', 'Triangular,10%=2,50%=5,Max=12',
  'Triangular,Min=1,Likeliest=5,50%=5', 'Triangular,Min=-10,Likeliest=0,99%=25', 'Triangular,25%=100,Likeliest=140,75%=200',
  'Triangular,Likeliest=5,10%=2,90%=9',
  'BetaPERT,5%=1,Likeliest=4,95%=12', 'BetaPERT,10%=100,Likeliest=150,90%=260', 'BetaPERT,Min=0,50%=4,Max=10',
  'BetaPERT,10%=2,50%=4.5,90%=9', 'BetaPERT,Min=1000,Likeliest=1200,80%=1500',
  'Beta,Min=0,Max=10,25%=3,75%=6', 'Beta,10%=1,90%=8,Alpha=2,Beta=3', 'Beta,Min=0,90%=8,Alpha=2,Beta=3',
  'Beta,10%=1,Max=10,Alpha=2,Beta=3', 'Beta,Min=5,Max=15,Alpha=1.5,50%=9', 'Beta,Min=0,Max=1,5%=0.05,95%=0.6',
  'LogNormal,10%=80,50%=100,90%=140', 'LogNormal,5%=1,50%=3,95%=12', 'LogNormal,LogMean=4,90%=120,Location=0',
  'LogNormal,10%=80,LogStdDev=0.2,Location=0', 'LogNormal,GeoMean=100,90%=130,Location=0', 'LogNormal,10%=80,GeoStdDev=1.2,Location=0',
  'LogNormal,Mean=100,StdDev=15,10%=70', 'LogNormal,LogMean=4.5,LogStdDev=0.2,25%=80', 'LogNormal,Mean=100,90%=120,25%=80',
  'LogNormal,10%=8000,90%=12000,Location=1000', 'LogNormal,Mean=0.05,90%=0.08,Location=0',
  'Gamma,10%=2,50%=4,90%=9', 'Weibull,10%=2,50%=4,90%=9', 'Student,10%=80,90%=120,50%=100',
  'Normal,90%=120,Mean=100', 'Triangular,90%=9,Min=0,Likeliest=5',
];
const [mode, casesFile, answersFile] = process.argv.slice(2);
if (mode === 'merge') {
  const qs = JSON.parse(readFileSync(casesFile, 'utf8'));
  const as = JSON.parse(readFileSync(answersFile, 'utf8'));
  console.log(JSON.stringify(qs.map((q, i) => ({ ...q, inv: as[i].inv, error: as[i].error })), null, 1));
} else {
  console.log(JSON.stringify(cases.map((text) => ({ text, probs: P }))));
}
