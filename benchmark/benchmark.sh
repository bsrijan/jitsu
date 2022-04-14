#!/usr/bin/env bash
read -p "Enter jitsu verstion [latest]: " jitsu_version
read -p "Enter api token (stream, batch, transform, transform_batch) [transform]: " api_token
read -p "Enter mode (bulk, event) [event]: " test_mode
#read -p "Enter events count [1_000_000]: " events
#read -p "Enter requests concurrency [100]: " concurrency

JITSU_VERSION=${jitsu_version:-latest} docker-compose up &

trap ctrl_c INT

function ctrl_c() {
   docker-compose down -v
   exit
}



#while [[ "$(curl http://localhost:8001/api/v1/event?token=${api_token:-transform} -s -o /dev/null -w ''%{http_code}'' -X POST --data @request.json)" != "200" ]];
#do
#  sleep 5;
#  echo "Waiting for destination to init. That could take up to minute if postgres wasn't ready for the first attempt...."
#done
echo "Waiting for destination to init. That could take up to minute if postgres wasn't ready for the first attempt...."
sleep 65

if [[ $test_mode -eq "bulk" ]]
then
bulkEvents=$(grep -c event bulk.json)
echo "Bulk mode. Events in bulk: ${bulkEvents}"
events=${events:-1000000}
events=$((events / bulkEvents))
concurrency=${concurrency:-100}
concurrency=$((concurrency / bulkEvents))
echo "Requests: ${events}"
#curl  -vvv --data @bulk.json -H 'Content-Type: multipart/form-data; boundary=---------------------------3587754863202700235388351790' -X POST http://localhost:8001/api/v1/events/bulk?token=${api_token:-transform}
docker run --rm --net=benchmark_main -p 18888:18888 -v $PWD/bulk.json:/tmp/bulk.json ghcr.io/six-ddc/plow -c ${concurrency:-100} -n ${events:-1000000} --body @/tmp/bulk.json -T 'multipart/form-data; boundary=---------------------------3587754863202700235388351790' -m POST http://jitsu:8001/api/v1/events/bulk?token=${api_token:-transform}
else
docker run --rm --net=benchmark_main -p 18888:18888 -v $PWD/request.json:/tmp/request.json ghcr.io/six-ddc/plow -c ${concurrency:-100} -n ${events:-1000000} --body @/tmp/request.json -T application/json -m POST http://jitsu:8001/api/v1/event?token=${api_token:-transform}
fi
read -p "Press enter to shutdown jitsu: " confirm

docker-compose down -v

#      - "-c"
#      - "${CONCURRENCY:-100}"
#      - "-n"
#      - "${REQUESTS:-100000}"
#      - "--body"
#      - "@/tmp/request.json"
#      - "-T"
#      - "application/json"
#      - "-m"
#      - "POST"
#      - "http://jitsu:8000/api/v1/event?token=${API_KEY:-transform_api_key}"