#!/usr/bin/perl
# A steady terminal stream of about 16 MiB/s. Larger writes than a bare `yes`
# keep the trace to hundreds of megabytes instead of gigabytes per run.
use strict;
use warnings;
use File::Basename qw(dirname);
use Time::HiRes qw(sleep);

my $pidfile = dirname($0) . '/flood.pid';
open(my $out, '>', $pidfile) or die "cannot write $pidfile: $!";
print $out "$$\n";
close($out) or die "cannot close $pidfile: $!";

$| = 1;
my $line = "the quick brown fox\n";
my $chunk = $line x int(65536 / length($line));
while (1) {
    print $chunk;
    sleep(0.004);
}
