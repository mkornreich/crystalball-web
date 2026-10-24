import { describe, expect, it } from 'vitest';
import { BUILTIN_FORMATS, formatGeneral, formatValue } from '../number-format';

describe('Excel number formats', () => {
  it('shows General as Excel does', () => {
    expect(formatGeneral(2500)).toBe('2500');
    expect(formatGeneral(1 / 3)).toBe('0.333333333');
    expect(formatGeneral(-1.5)).toBe('-1.5');
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(123456.789012)).toBe('123456.789');
    expect(formatGeneral(123456789012)).toBe('1.23457E+11');
    expect(formatGeneral(0.0000012345)).toBe('1.2345E-06');
    expect(formatGeneral(9999999999.6)).toBe('10000000000');
  });

  it('formats numbers, currency, percent, scaling and scientific', () => {
    const usd = BUILTIN_FORMATS[7];
    expect(formatValue(500, usd)).toBe('$500.00 ');
    expect(formatValue(-2500.5, usd)).toBe('($2,500.50)');
    expect(formatValue(0.15, '0%')).toBe('15%');
    expect(formatValue(0.12345, '0.00%')).toBe('12.35%');
    expect(formatValue(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(formatValue(1.005, '0.00')).toBe('1.01');
    expect(formatValue(-0.4, '0')).toBe('-0');
    expect(formatValue(1234567, '#,##0,')).toBe('1,235');
    expect(formatValue(1234567, '$#,##0.0,,"M"')).toBe('$1.2M');
    expect(formatValue(12345, '0.00E+00')).toBe('1.23E+04');
    expect(formatValue(0.5, '#.##')).toBe('.5');
    expect(formatValue(-1000, '$#,##0')).toBe('-$1,000');
    expect(formatValue(1234.5, BUILTIN_FORMATS[44])).toBe(' $1,234.50 ');
    expect(formatValue(7, '0 "units"')).toBe('7 units');
    expect(formatValue(1234.5, '[$€-407] #,##0.00')).toBe('€ 1,234.50');
  });

  it('formats dates and times from Excel serials', () => {
    expect(formatValue(45000, 'm/d/yyyy')).toBe('3/15/2023');
    expect(formatValue(45000, 'd-mmm-yy')).toBe('15-Mar-23');
    expect(formatValue(45000.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(formatValue(45000.5, 'dddd, mmmm d, yyyy hh:mm')).toBe('Wednesday, March 15, 2023 12:00');
    expect(formatValue(1.5, '[h]:mm:ss')).toBe('36:00:00');
    expect(formatValue(60, 'yyyy-mm-dd')).toBe('1900-02-29');
    expect(formatValue(61, 'yyyy-mm-dd')).toBe('1900-03-01');
  });

  it('formats text and booleans', () => {
    expect(formatValue('abc', '@')).toBe('abc');
    expect(formatValue('abc', '0;-0;0;"Item: "@')).toBe('Item: abc');
    expect(formatValue(true)).toBe('TRUE');
    expect(formatValue(null)).toBe('');
  });
});
