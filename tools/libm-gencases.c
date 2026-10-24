/* Write N random inputs per function with the system libm's results, as raw doubles:
   <dir>/<fn>.bin = [x, f(x)]... (pow: [x, y, pow(x, y)]...). Inputs cover the ranges
   Crystal Ball's kernels use plus wide random bit patterns. */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static uint64_t s = 0x9e3779b97f4a7c15ull;
static uint64_t next (void) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return s; }
static double rnd (void) { return (next () >> 11) * 0x1.0p-53; }
static double between (double a, double b) { return a + (b - a) * rnd (); }
static double wide (double a, double b) { return exp (between (log (a), log (b))); }
static double anybits (void) { uint64_t u = next (); double d; memcpy (&d, &u, 8); return d; }
static FILE *open (const char *dir, const char *fn) { char p[512]; snprintf (p, sizeof p, "%s/%s.bin", dir, fn); return fopen (p, "wb"); }
typedef double (*f1) (double);
static void one (const char *dir, const char *name, f1 f, double (*gen) (void), long n) {
  FILE *o = open (dir, name);
  for (long i = 0; i < n; i++) { double x = gen (), r[2] = { x, f (x) }; fwrite (r, 8, 2, o); }
  fclose (o);
}
static double g_exp (void) { double u = rnd (); return u < 0.05 ? anybits () : u < 0.3 ? between (-745.2, 709.8) : u < 0.8 ? between (-40, 40) : between (-1, 1); }
static double g_log (void) { double u = rnd (); return u < 0.05 ? fabs (anybits ()) : u < 0.4 ? wide (1e-308, 1e308) : u < 0.7 ? between (0.9, 1.1) : between (1e-6, 3); }
static double g_sin (void) { double u = rnd (); return u < 0.05 ? anybits () : u < 0.6 ? between (-4, 4) : u < 0.8 ? between (-1e6, 1e6) : wide (1e-12, 1) * (rnd () < 0.5 ? -1 : 1); }
static double g_tan (void) { double u = rnd (); return u < 0.05 ? anybits () : u < 0.7 ? between (1e-6, 1.5707963) : u < 0.9 ? between (-10, 10) : wide (1e-12, 1e8); }
static double g_atan (void) { double u = rnd (); return u < 0.05 ? anybits () : wide (1e-12, 1e12) * (rnd () < 0.5 ? -1 : 1); }
static double g_asin (void) { double u = rnd (); return u < 0.05 ? between (-1.2, 1.2) : u < 0.8 ? between (-1, 1) : (1 - wide (1e-16, 1e-2)) * (rnd () < 0.5 ? -1 : 1); }
int main (int argc, char **argv) {
  const char *dir = argv[1]; long n = atol (argv[2]);
  volatile f1 fe = exp, fl = log, f10 = log10, fs = sin, fc = cos, ft = tan, fa = atan, fas = asin;
  one (dir, "exp", fe, g_exp, n); one (dir, "log", fl, g_log, n); one (dir, "log10", f10, g_log, n);
  one (dir, "sin", fs, g_sin, n); one (dir, "cos", fc, g_sin, n); one (dir, "tan", ft, g_tan, n);
  one (dir, "atan", fa, g_atan, n); one (dir, "asin", fas, g_asin, n);
  volatile double (*fp) (double, double) = pow; FILE *o = open (dir, "pow");
  for (long i = 0; i < n; i++) {
    double u = rnd (), x, y;
    if (u < 0.05) { x = anybits (); y = anybits (); }
    else if (u < 0.4) { x = wide (1e-6, 1e6); y = between (-60, 60); }
    else if (u < 0.6) { x = rnd (); y = between (0, 300); }
    else if (u < 0.8) { x = wide (1e-3, 1e3); y = (double) (long) between (-50, 50); }
    else { x = between (0.5, 2); y = wide (1e-3, 1e3) * (rnd () < 0.5 ? -1 : 1); }
    double r[3] = { x, y, fp (x, y) }; fwrite (r, 8, 3, o);
  }
  fclose (o);
}
