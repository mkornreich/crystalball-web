/* Print glibc's exp/log/pow data tables (as compiled with -mfma) as JSON of IEEE bit patterns. */
#include <stdio.h>
#include <string.h>
#include "math_config.h"
static void d (const char *k, double v, int last) { uint64_t u; memcpy (&u, &v, 8); printf ("\"%s\":\"%016llx\"%s", k, (unsigned long long) u, last ? "" : ","); }
static void arr (const char *k, const double *v, int n, int stride, int last) {
  printf ("\"%s\":[", k);
  for (int i = 0; i < n; i++) { uint64_t u; memcpy (&u, v + i * stride, 8); printf ("\"%016llx\"%s", (unsigned long long) u, i < n - 1 ? "," : ""); }
  printf ("]%s", last ? "" : ",");
}
int main () {
  printf ("{\"exp\":{");
  d ("invln2N", __exp_data.invln2N, 0); d ("negln2hiN", __exp_data.negln2hiN, 0); d ("negln2loN", __exp_data.negln2loN, 0);
  d ("shift", __exp_data.shift, 0); arr ("poly", __exp_data.poly, 4, 1, 0);
  printf ("\"tab\":[");
  for (int i = 0; i < 256; i++) printf ("\"%016llx\"%s", (unsigned long long) __exp_data.tab[i], i < 255 ? "," : "");
  printf ("]},\"log\":{");
  d ("ln2hi", __log_data.ln2hi, 0); d ("ln2lo", __log_data.ln2lo, 0);
  arr ("poly", __log_data.poly, LOG_POLY_ORDER - 1, 1, 0); arr ("poly1", __log_data.poly1, LOG_POLY1_ORDER - 1, 1, 0);
  arr ("invc", &__log_data.tab[0].invc, 128, 2, 0); arr ("logc", &__log_data.tab[0].logc, 128, 2, 1);
  printf ("},\"pow\":{");
  d ("ln2hi", __pow_log_data.ln2hi, 0); d ("ln2lo", __pow_log_data.ln2lo, 0);
  arr ("poly", __pow_log_data.poly, POW_LOG_POLY_ORDER - 1, 1, 0);
  arr ("invc", &__pow_log_data.tab[0].invc, 128, 4, 0); arr ("logc", &__pow_log_data.tab[0].logc, 128, 4, 0); arr ("logctail", &__pow_log_data.tab[0].logctail, 128, 4, 1);
  printf ("}}\n");
}
