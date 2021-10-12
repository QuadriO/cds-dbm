#!/bin/bash
export JAVA_HOME=/home/vcap/deps/0/apt/usr/lib/jvm/sapmachine-11
export PATH=$PATH:/home/vcap/deps/1/bin
# Save Certificate from Environment where liquibase expects it
mkdir -p /home/vcap/.db2
export DB2_ROOT_CERT="/home/vcap/.db2/root.crt"
echo $VCAP_SERVICES | jq --raw-output '."db2-db"[0].credentials.sslrootcert' > $DB2_ROOT_CERT
# Execution cmd will be inserted in the next line
