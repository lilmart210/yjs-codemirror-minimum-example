import { createSignal, onCleanup, onMount } from 'solid-js'
import { EditorView } from 'codemirror'
import { Compartment,Annotation } from '@codemirror/state'
import { ViewPlugin, ViewUpdate,Decoration,WidgetType, keymap } from '@codemirror/view'
import * as yjs from 'yjs'
import './App.css'

//inspired by https://github.com/yjs/y-codemirror.next

const SyncAnnotation = Annotation.define();

const location = 'ws://localhost:5264'

class RemoteCursorWidget extends WidgetType {
	constructor(color,name){
		super();
		this.color = color;
		this.name = name;
	}
	toDOM(){
		const span = document.createElement('span');
		span.className = "remote-cursor";
		span.style.setProperty('--remote-color',this.color);
		span.title = this.name || 'Anonymous'; // this is the tooltip

		return span;
	}
}

function YjsViewPlugin(doc,ydoc, aws) {
	const comp = new Compartment();
	const identity = new Date().getTime();

	const undomanager = new yjs.UndoManager(ydoc,{
		trackedOrigins : new Set([identity])
	});

	const myplugin = ViewPlugin.fromClass(class {
		constructor(aview) {
			/**@type {EditorView} */
			this.view = aview;
			/**@type {yjs.Text} */
			this.ydoc = ydoc;
			/**@type {yjs.Doc} */
			this.doc = doc;
			//get and apply the starting document
			this.observing = this.observing.bind(this);	
			this.receiveUpdates = this.receiveUpdates.bind(this);
			this.observeText = this.observeText.bind(this);
			this.updateDecorations = this.updateDecorations.bind(this);

			// a number for this users identity
			this.identity = identity;
			
			// random hex
			this.color = '#' + Math.floor(Math.random() * 16777215).toString(16); 
			this.remoteCursors = new Map();
			this.decorations = Decoration.none
			//add a change listener to ydoc
			//this.ydoc.observe(this.observing);
			//this.doc.observe(this.observing);
			this.doc.on('updateV2',this.observing);
			this.ydoc.observe(this.observeText);

			aws.addEventListener('message',this.receiveUpdates)
			

		}

		/**
		 * 
		 * @param {yjs.YTextEvent} event 
		 * @param {yjs.Transaction} transaction 
		 */
		observeText(event,transaction){
			if(transaction.origin == this.identity) return;
			//apply updates from external transactions from yjs to codemirror
			const delta = event.delta;
			const changes = [];
			let index = 0;
			for(const del of delta){
				if(del.retain !== undefined){
					//move cursor on old document
					index += del.retain;
				}else if(del.delete != undefined){
					//delete characters
					changes.push({
						from : index,
						to: index + del.delete,
						insert : ""
					})
					index += del.delete;
				}else if(del.insert != undefined){
					//insert at position
					changes.push({
						from : index,
						to : index,
						insert : del.insert
					})
				}
			}

			this.view.dispatch({
				changes,
				annotations : [SyncAnnotation.of(this.identity)]
			})

		}
		
		//observing(event,transaction){
		/**
		 * 
		 * @param {Uint8Array} update 
		 * @param {*} origin 
		 * @param {yjs.Doc} adoc 
		 * @returns 
		 */
		observing(update,origin,adoc){
			//process changes made to ydoc and send them to the server
			console.log("observed",update,origin,adoc);
			
			// avoid transaction whose origin is not this
			// allow changes from undo manager
			if(origin != this.identity && origin != undomanager) return;

			if(update.length == 0) return;
			const bsix = update.toBase64();
			
			aws.send(JSON.stringify({
				msg : "Update",
				update : bsix,
				from : this.identity
			}))
			
			//send these transactions to the server to be processed
			
		}

		receiveUpdates(event){
			console.log("got messages",event.data);
			//recieve changes from the server and process them.
			//recieve these changes from the server

			const info = JSON.parse(event.data);
			
			if(info.msg == 'Update'){
				const bin = Uint8Array.fromBase64(info.update);
				yjs.applyUpdateV2(this.doc,bin,info.from);	
			}else if(info.msg == 'Awareness'){
				if(info.from == this.identity) return;
				
				const anchor = yjs.createRelativePositionFromJSON(info.anchor);
				const head = yjs.createRelativePositionFromJSON(info.head);
				
				this.remoteCursors.set(info.from,{
					color : info.color,
					anchor : anchor,
					head : head,
				})

				this.updateDecorations();
				this.view.dispatch({effects : []})
			}
		}
		updateDecorations(){
			const decorations = [];
			
			
			this.remoteCursors.forEach((cursor,clientId)=>{
				//convert from yjs to codemirror absolute
				const abscursor = yjs.createAbsolutePositionFromRelativePosition(cursor.anchor,this.doc);
				const abshead = yjs.createAbsolutePositionFromRelativePosition(cursor.head,this.doc);

				//if something is missing or wrong doc, skip
				if(!abscursor || !abshead || abscursor.type != this.ydoc || abshead.type != this.ydoc) return;
				
				const anchor = abscursor.index;
				const head = abshead.index;
				const start = Math.min(abscursor.index,abshead.index);
				const end = Math.max(abscursor.index,abshead.index);
				console.log("VALUES",anchor,head,start,end);
				//don't draw if its not visible
				if(start != end){
					decorations.push(Decoration.mark({
						attributes : {
							style : `--remote-background : ${cursor.color}40`
						},
						class : 'remote-selection'
					}).range(start,end))
				}
				//draw the other users cursor
				decorations.push(Decoration.widget({
					widget : new RemoteCursorWidget(cursor.color,"User " + clientId),
					side : 1
				}).range(head))
			})

			//sort the decorations (required by code mirror)
			decorations.sort((a,b)=>{
				if(a.from !== b.from) return a.from - b.from;
				return a.value.startSide - b.value.startSide
			});

			this.decorations = Decoration.set(decorations);

			//setTimeout(()=>this.view.dispatch({effects : []})) // trigger an update?
			console.log("DECORATIONS",decorations);
		}

		/**
		 * 
		 * @param {ViewUpdate} update 
		 */
		update(update) {
			//get annotation from update if it exists
			const fromSelf = update.transactions[0]?.annotation(SyncAnnotation) == this.identity;
			if(update.selectionSet){
				//send selection to everyone and update
				const sel = this.view.state.selection.main;
				const anchor = yjs.createRelativePositionFromTypeIndex(this.ydoc,sel.anchor);
				const head = yjs.createRelativePositionFromTypeIndex(this.ydoc,sel.head);

				aws.send(JSON.stringify({
					msg : 'Awareness',
					from : this.identity,
					color : this.color,
					anchor : anchor,
					head : head
				}))
			}
			if(!update.docChanged || fromSelf) return;
			
			//console.log("We got changes",update.changes.toJSON(),update);
			
			//apply changes to ydoc
			let adjust = 0;
			
			
			doc.transact((tr)=>{
				//Track changes from Plain and Rich Text Documents
				
				//conver the changes into yjs delta format and apply these to the ydoc
				update.changes.iterChanges((froma,toa,fromb,tob,inserted)=>{
					//console.log("changes",froma,toa,fromb,tob,inserted);

					const insertedText = inserted.sliceString(0,inserted.length,'\n');
					const delLength = toa-froma;

					const actual_position = froma + adjust;

					// handle deletion, selection,replaced
					if(delLength > 0){
						this.ydoc.delete(actual_position,delLength);
					}

					if(insertedText.length > 0){
						this.ydoc.insert(actual_position,insertedText);

					}

					adjust += insertedText.length - delLength;
				})

			},this.identity)

			

			if(update.docChanged || update.viewportChanged) this.updateDecorations();

		}

		destroy() {
			//does nothing at the moment
			this.ydoc.unobserve(this.observeText);
			this.doc.off('updateV2',this.observing)

			aws.removeEventListener(this.receiveUpdates);
			undomanager.destroy();
		}
	},{decorations : (v)=>v.decorations})


	return [
		//websocket and text updates
		comp.of(myplugin),
		//key history
		keymap.of([
			{key : "Mod-z",run : ()=>{undomanager.undo(); return true;}},
			{key : "Mod-y",run : ()=>{undomanager.redo(); return true;}},
			{key : "Mod-Shift-z",run : ()=>{undomanager.redo(); return true;}}
		])
	]
}

function MakeDocumentHandler(){
	
}


function App() {
	const [Eview, SetEview] = createSignal();

	let Editor;

	function SocketListener(msg) {
		console.log("got message from socket", msg);

	}

	onMount(() => {
		const aws = new WebSocket(location);

		aws.onclose = (ev) => console.log("Socket Closed", ev);
		aws.onerror = (ev) => console.log("Socket error", ev);
		aws.onopen = (ev) => {
			console.log("getting the starting document");
			aws.send(JSON.stringify({ msg: "Get Document" }))
		}

		aws.onmessage = (ev) => {
			console.log("Setting up the websocket");
			const adoc = JSON.parse(ev.data);

			//the first message is the document
			const textdoc = adoc.document;
			
			//Convert the yjs text to string for the starting document
			/**@type {yjs.Doc} */
			const adocument = new yjs.Doc();

			//const binarr = new TextEncoder().encode(bindoc);
			const binarr = Uint8Array.fromBase64(textdoc);

			console.log("recieved", binarr);

			//this is the starting document
			yjs.applyUpdateV2(adocument, binarr);
			const yjsdoc = adocument.getText('y-document');
			const plaintext = yjsdoc.toString();


			const yplug = YjsViewPlugin(adocument,yjsdoc, aws)

			const view = new EditorView({
				doc: plaintext,
				parent: Editor,
				extensions: [
					yplug
				]
			})
			SetEview(view);

			aws.onmessage = SocketListener
		}


		return onCleanup(() => {
			if (!Eview()) return;

			Eview().destroy();
		})
	})


	return (
		<div className='Main'>
			<div ref={Editor} className='Editor'>

			</div>
		</div>
	)
}

export default App
