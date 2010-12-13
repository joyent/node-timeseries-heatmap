/*
 * This example allows one to interact with multidimensional heatmaps on a
 * live basis.  To run it, you will need to have node-libdtrace (in addition
 * to node-png).  Run it by specifying either a D script or a configuration
 * file that points to a D script (see example-dtrace-cpu.conf for an example
 * configuration file).  The D script must contain two aggregations:  one that
 * is the total of all events and another that decomposes those events in some
 * dimension.  (Example scripts are provided in example-dtrace-cpu.d and
 * example-dtrace-syscall.d.)  Once started, it will emit the script to stdout
 * and listen on the specified port (8001 if not specified via the PORT
 * environment variable).  Then via a browser, go to http://localhost:8001 --
 * you should see the live heatmap, and then be able to click on decomposed
 * elements to highlight them.  (In term of editing or expanding this demo,
 * note that the client-side code is contained in example-dtrace.html.)
 */
var path = require('path');
require.paths.unshift(path.dirname(__dirname) + '/lib');

var http = require('http');
var port = process.env.PORT || 8001;
var sys = require('sys');
var heatmap = require('heatmap');
var libdtrace = require('libdtrace');
var fs = require('fs');
var url = require('url');
var querystring = require('querystring');
var name = 'example-dtrace';

var fatal = function (err)
{
	sys.puts(name + ': ' + err);
	process.exit(1);
}

var readConfiguration = function (fname)
{
	var conf;
	var defaults = { min: 0, max: 100000 }, prop;

	try {
		conf = fs.readFileSync(fname).toString();
	} catch (err) {
		fatal('could not open file "' + fname + '": ' + err);
	}

	try {
		eval(conf);
	} catch (err) {
		d = defaults;
		d.program = conf;
		return;
	}

	if (!d || !(d instanceof Object)) {
		fatal('configuration file "' + fname + '" did not set ' +
		     'expected object "d"');
	}

	if (!d.program) {
		if (!d.script) {
			fatal('did not find D script or program in ' +
			     'configuration file "' + fname + '"');
		}

		try {
			d.program = fs.readFileSync(d.script).toString();
		} catch (err) {
			fatal('could not open specified script "' +
			    d.script + '": ' + err);
		}
	}

	for (prop in defaults) {
		if (!d.hasOwnProperty(prop))
			d[prop] = defaults[prop];
	}
}

if (process.argv.length <= 2)
	fatal('expected D script to execute or configuration file');

readConfiguration(process.argv[process.argv.length - 1]);

sys.puts('vvv D program vvv');
sys.puts(d.program);
sys.puts('^^^ D program ^^^');

dtp = new libdtrace.Consumer();
dtp.strcompile(d.program);
dtp.go();

var total = {};
var decomposed = {};
var present = {};

var sample = 0;
var keep = 3600;
var start = 0;

setInterval(function () {
	sample = Math.floor((new Date()).valueOf() / 1000);

	dtp.aggwalk(function (varid, key, val) {
		switch (varid) {
		case 1:
			if (key.length != 0)
				fatal("first aggregation must be unkeyed");

			data = total;
			break;

		case 2:
			if (key.length != 1)
				fatal("second aggregation must have one key");

			if (!decomposed[key[0]])
				decomposed[key[0]] = {};

			if (!present[key[0]])
				present[key[0]] = 0;

			data = decomposed[key[0]];
			present[key[0]]++;
			break;

		default:
			fatal("expected at most two aggregations");
		}

		data[sample] = val;
	});

	if (sample < keep)
		return;

	if (total[sample - keep])
		delete total[sample - keep];

	for (elem in decomposed) {
		if (decomposed[elem][sample - keep]) {
			delete decomposed[elem][sample - keep];
			present[elem]--;
		}
	}
}, 1000);

var dynamic = function (req, res)
{
	var uri = url.parse(req.url, true);
	var conf, c;

	sys.puts(sys.inspect(uri));

	conf = {
		height: 300,
		width: 1000,
		min: 0,
		max: 100000,
		nbuckets: 100,
		nsamples: 60,
		base: 0,
		x: 0,
		y: 0
	};

	booleans = {
		weighbyrange: true,
		linear: true
	};

	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Transfer-Encoding': 'chunked'
	});	

	for (c in uri.query) {
		if (conf.hasOwnProperty(c))
			conf[c] = parseInt(uri.query[c], 10);

		if (booleans[c])
			conf[c] = parseInt(uri.query[c], 10) ? true : false;
	}

	if (!conf.base)
		conf.base = sample - conf.nsamples;

	if (uri.pathname == '/heatmap') {
		var primary, hue = [ 21 ], datasets;
		var selected = [], elem;

		if (!uri.query.isolate) {
			primary = heatmap.bucketize(total, conf);
			datasets = [ primary ];
		} else {
			primary = undefined;
			datasets = [];
		}

		if (uri.query.selected) {
			selected = uri.query.selected.split(',');
		} else if (uri.query.vomit) {
			/*
			 * This is obscenely inefficient by every metric but
			 * lines of code (but sometimes lines of code is
			 * the metric that counts).  If this becomes a problem,
			 * there are (many) much more efficient ways of doing
			 * this...
			 */
			for (elem in decomposed)
				selected.push(elem);
		}

		if (selected.length > 0) {
			var already = {}, i;

			for (i = 0; i < selected.length; i++) {
				var data = decomposed[selected[i]];

				if (!data || already[selected[i]])
					continue;

				var nary = heatmap.bucketize(data, conf);

				if (primary)
					heatmap.deduct(primary, nary);

				already[selected[i]] = true;

				if (uri.query.exclude)
					continue;

				datasets.push(nary);
				hue.push((hue[hue.length - 1] + (91)) % 360);
			}
		}

		if (uri.query.isolate)
			hue.shift();

		if (datasets.length === 0) {
			datasets = [ heatmap.bucketize({}, conf) ];
			hue = [ 0 ];
		}

		heatmap.normalize(datasets, conf);

		conf.hue = hue;
		conf.saturation = [ 0, .9 ];
		conf.value = 0.95;

		var png = heatmap.generate(datasets, conf);

		res.end('{"base": ' + conf.base + ',"image": "' +
		    png.encodeSync().toString('base64') +
		    '","decomposition":' + JSON.stringify(present) + '}');
		return;
	}

	if (uri.pathname == '/details') {
		var sr = heatmap.samplerange(conf.x, conf.y, conf);

		conf = {
			base: sr[0],
			min: sr[1][0],
			max: sr[1][1],
			nbuckets: 1,
			nsamples: 1
		};

		var rval = { sample: conf.base, min: conf.min, max: conf.max };

		rval.total = Math.round(heatmap.bucketize(total, conf)[0][0]);

		if (rval.total != 0) {
			var elem, b;

			rval.decomposition = {};

			for (elem in decomposed) {
				if (!decomposed[elem][rval.sample])
					continue;

				b = heatmap.bucketize(decomposed[elem], conf);

				if (b < 1)
					continue;

				rval.decomposition[elem] = Math.round(b[0][0]);
			}
		}

		res.end(JSON.stringify(rval));
		return;
	}

	if (uri.pathname == '/conf') {
		res.end(JSON.stringify(d));
		return;
	}

	res.writeHead(404);
	res.end();
}

http.createServer(function (req, res) {
	var uri = url.parse(req.url).pathname;
	var index = false;

	if (uri == '/') {
		index = true;
		uri = '/' + name + '.html';
	}

	var filename = path.join(process.cwd(), uri);

	fs.readFile(filename, function (err, file) {
		if (err) {
			if (index) {
				fatal('could not find index file "' +
				     filename + '"');
			}

			return (dynamic(req, res));
		}

		res.writeHead(200);
		res.write(file);
		res.end();
	});
}).listen(port);

