#!/usr/bin/env bash
# Argument parser for build-driver stand-ins. It has no container side effects.

sdme_stub_refuse() {
    printf 'stub sdme: %s\n' "$1" >&2
    return 2
}

sdme_stub_parse() {
    SDME_STUB_COMMAND=
    SDME_STUB_NAME=
    SDME_STUB_PAYLOAD=()
    SDME_STUB_OPTIONS=()
    local command storage='' disk='' boundary=0 option

    while [ "${1:-}" = --config ]; do
        [ "$#" -ge 2 ] && [ -n "$2" ] || { sdme_stub_refuse '--config needs a value'; return 2; }
        shift 2
    done
    [ "$#" -gt 0 ] || { sdme_stub_refuse 'missing command'; return 2; }
    command="$1"
    # shellcheck disable=SC2034  # consumed by the stand-in after sourcing
    SDME_STUB_COMMAND="$command"
    shift

    case "$command" in
        new|create)
            while [ "$#" -gt 0 ]; do
                option="$1"
                case "$option" in
                    --config|--name|-r|-t|--storage|--disk|--cpus|--memory|-b|--env)
                        [ "$#" -ge 2 ] && [ -n "$2" ] || { sdme_stub_refuse "$option needs a value"; return 2; }
                        SDME_STUB_OPTIONS+=("$1" "$2")
                        case "$option" in
                            --name) SDME_STUB_NAME="$2" ;;
                            --storage) storage="$2" ;;
                            --disk) disk="$2" ;;
                        esac
                        shift 2
                        ;;
                    --started)
                        [ "$command" = create ] || { sdme_stub_refuse 'new does not accept --started'; return 2; }
                        SDME_STUB_OPTIONS+=("$1")
                        shift
                        ;;
                    --)
                        [ "$command" = new ] || { sdme_stub_refuse 'create has no payload'; return 2; }
                        boundary=1
                        shift
                        SDME_STUB_PAYLOAD=("$@")
                        break
                        ;;
                    *) sdme_stub_refuse "unexpected argument $option"; return 2 ;;
                esac
            done
            [ -n "$SDME_STUB_NAME" ] || { sdme_stub_refuse 'missing --name'; return 2; }
            [ -z "$disk" ] || [ "$storage" = btrfs ] || { sdme_stub_refuse '--disk requires --storage btrfs'; return 2; }
            if [ "$command" = new ]; then
                [ "$boundary" -eq 1 ] && [ ${#SDME_STUB_PAYLOAD[@]} -gt 0 ] || { sdme_stub_refuse 'new needs -- before payload'; return 2; }
            fi
            ;;
        exec)
            while [ "${1:-}" = --config ]; do
                [ "$#" -ge 2 ] && [ -n "$2" ] || { sdme_stub_refuse '--config needs a value'; return 2; }
                shift 2
            done
            [ "$#" -ge 2 ] || { sdme_stub_refuse 'exec needs name and payload'; return 2; }
            SDME_STUB_NAME="$1"
            shift
            [ "${1:-}" != -- ] || shift
            [ "$#" -gt 0 ] || { sdme_stub_refuse 'exec needs a payload'; return 2; }
            SDME_STUB_PAYLOAD=("$@")
            ;;
        fs|ps|rm|cp|stop|start) SDME_STUB_PAYLOAD=("$@") ;;
        *) sdme_stub_refuse "unknown command $command"; return 2 ;;
    esac
}
