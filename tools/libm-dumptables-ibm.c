/* Print the IBM-derived tables of glibc's sin/tan/atan/asin (little-endian) as JSON bit patterns. */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "endian.h"
#include "mydefs.h"
#include "branred.h"
#include "utan.tbl"
#include "uatan.tbl"
#include "asincos.tbl"
#include "root.tbl"
#include "powtwo.tbl"
extern const union { int4 i[880]; double x[440]; } __sincostab;
static void arr (const char *k, const double *v, int n, int last) {
  printf ("\"%s\":[", k);
  for (int i = 0; i < n; i++) { uint64_t u; memcpy (&u, v + i, 8); printf ("\"%016llx\"%s", (unsigned long long) u, i < n - 1 ? "," : ""); }
  printf ("]%s", last ? "" : ",");
}
int main () {
  printf ("{\"ibm\":{");
  arr ("sincostab", __sincostab.x, 440, 0);
  arr ("toverp", toverp, 75, 0);
  arr ("xfg", &xfg[0][0].d, 186 * 4, 0);
  arr ("cij", &cij[0][0].d, 241 * 7, 0);
  arr ("asncs", asncs.x, 2568, 0);
  arr ("inroot", inroot, 128, 0);
  arr ("powtwo", powtwo, sizeof powtwo / sizeof powtwo[0], 1);
  printf ("}}\n");
}
