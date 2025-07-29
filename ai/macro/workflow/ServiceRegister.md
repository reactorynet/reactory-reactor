# Service Register Macro
The Service Register Macro provides two capabilities.

1. list - the list macro will list all the services registered with this instance.
2. get - gets an instance of a service. If a list of arguments are provided the instance be executed with the given paramters.

## Usage
@svc(list) - lists services
@svc(get) - returns a service instance
@svc(get, feature, param1, param2) - executes the feature provided by the service and passes the parameters through.