#include <stdio.h>
int helper(void) { return 1; }
int main(void) { return printf("café %d", helper()); }
