#!/bin/bash

set -e

# Do not use associative arrays - not supported on Mac!
declare -a testCases
testCases=(
bpa "data.bloodpac.org"
dcf "nci-crdc.datacommons.io"
gtex "gen3.biodatacatalyst.nhlbi.nih.gov"
)
index=0
while [[ $index -lt ${#testCases[@]} ]]; do
  APP=${testCases[$index]}
  let index+=1
  HOSTNAME=${testCases[$index]}
  let index+=1
  export APP
  export HOSTNAME
  echo "Run setup for $APP $HOSTNAME"
  npm run schema
  npm run relay
done
