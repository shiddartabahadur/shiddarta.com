---
title: 'Making Core Data Functional'
date: 2021-04-25 21:01:52
category: iOS
draft: false
showToc: true
---

> Using functional-programming, we aim to make thread-management task in CoreData easier by creating new containers.

## Thread safety

Many operations in CoreData are wrapped in either an async perform blocks, or their synchronous counterpart `performAndWait` . Both referred as the perform blocks hereafter.

For example, we look at how we might approach things to make an object “Baby”.

P/S: Just not your normal way of making babies🤪

```swift
func makeBaby(in context: NSManagedObjectContext, name: String) {
	let baby = Baby(context: context)
	baby.name = name
}
```

While this might be the most straightforward implementation, it is not thread safe. So to protect against bad callers, we need to wrap our code in a `performAndWait` block.

```swift
func makeBaby(in context: NSManagedObjectContext, name: String) -> Baby {
	var baby: Baby
	context.performAndWait {
		baby = Baby(context: context)
		baby.name = name
	}
	return baby
}
```

The drawback is callers need to always double-check the implementation to make sure it’s always truly thread safe even the documents promise. Having said that, you know what’s worse? Writing it in a closed source SDK your company is trying to sell!

Another example:

```swift
func makeBabies(in context: NSManagedObjectContext, names: [String]) -> [Baby] {
	var babies: [Baby] = []
	context.performAndWait {
		for name in names {
			babies.append(makeBaby(in: context, name: name))
		}
	}
	return babies
}
}
```

Although one way to go about it is enforcing strict coding guidelines, but I’m still looking for a more foolproof (and scaleable) solution. To fix this, we are going to ask for some favour from Functional Programming (FP).

## Inspired by Functional Programming

One key thing about FP is – identifying the different code “patterns” we often come across and taking advantage of it by making abstractions around them. Here’s one pattern I noticed from my personal experience with many CoreData related APIs – they usually like to take in a NSManagedObjectContext object before they could run their operations.

So, this is what we can start with:

```swift
// Functional Programming in Core Data
struct FunctionalDataOperation 	{
	let operation: (NSManagedObjectContext) -> Void
}
```

The `operation` in the encapsulation above tells us that all it needs is a NSManagedObjectContext for doing its job of performing an operation. But there is one problem though: there’s no way to properly represent a fetch because it always return void. So, we revise it to the following:

```swift
struct FunctionalDataOperation<Element> {

	private let operation: (NSManagedObjectContext) -> Element

	public init (_ operation: @escaping (NSManagedObjectContext) -> Element) {
		self.operation = operation
	}
}
```

To make it more robust, we made operation a `private` attribute and thus forcing callers to trigger the operation closure through operate. Doing so could avoid it being called by other threads which might eventually result in threading issues.

```swift
struct FunctionalDataOperation<Element> {
	private let operation: (NSManagedObjectContext) -> Element
	func operate(_ context: NSManagedObjectContext) -> Element {
		var result: Element!
		context.performAndWait {
			result = operation(context)
		}
		return result
	}
}
```

Our current implementation will block the calling-thread and thus it is considered thread-safe. And of course, it’s definitely possible to do an async implementation too – I will leave it as an exercise for you (hint, hint – you might want to also consider taking in the running thread as a parameter too!).

```swift
extension FunctionalDataOperation {
	func operateAsync(_ context: NSManagedObjectContext, _ callback: @escaping (Element) -> Void)
	{
		context.perform {
			let result = self.operation(context)
			callback(result)
		}
	}
}
```

What we now have:

- Our current makeBaby function returns a baby, when given a NSManagedObjectContext and its name.

What we want:

- Applying FP technique to get an operation that creates and returns a baby in a specific NSManagedObjectContext.

Re-implementing the old `makeBaby` from this:

```swift
func makeBaby(in context: NSManagedObjectContext, name: String) -> Baby {
	var baby: Baby!
	context.performAndWait {
		baby = Baby(context:context)
		baby.name = name
	}
	return baby
}
```

To this:

```swift
func makeBabyOperation(name: String) -> FunctionalDataOperation<Baby> {
	// using type inference and trailing closure
	return FunctionalDataOperation { context in
		let baby = Baby(context:context)
		baby.name = name
		return baby
	}
}
```

Not much seems to have changed but you know what? Now we can just focus on writing the code and throw all the messy thread management to `FunctionalDataOperation`! The code now is much easier to maintain and succinct.

Awesome, isn’t it?

For context, we assume the code is running on the very same thread the Baby was created – so that it won’t crash when accessing the properties.

```swift
let myBaby = makeBabyOperation(name: ”Bae”).operate(context)
print(myBaby.name)
// prints “Bae”
```

Next up, we will re-implement the `makeBabies` function with `FunctionalDataOperation`.

```swift
func makeBabiesOperation(names: [String]) -> FunctionalDataOperation<[Baby]> {
	return FunctionalDataOperation { context in
		var babies: [Baby] = []

		for name in names {
			let makeBaby = makeBabyOperation(name: name)
			babies.append(makeBaby.operate(context))
		}
		return babies
	}
}
```

Although now the API is considered thread safe, the function is still very much imperative and certainly can be more concise.

## Enhancing with FP (Map)

Given a situation for a function to extract the name of a baby, there are 3 potential implementations that I could think of off the top of my head:

```swift
// First approach
// Normal implementation in CoreData - managing the threads.
func getNameFirst(of baby: Baby) -> String {
	var name: String!
	baby.managedObjectContext?.performAndWait {
		name = baby.name
	}
	return name
}

// Implemented with FunctionalDataOperation;
// But creating and running operation are in the same scope
// not very scalable for more complex operation.
func getNameSecond(of baby: Baby) -> String {
	let operation = FunctionalDataOperation<String> ( _ in
		return baby.name
	}
	return operation.operate(baby.managedObjectContext!)
}

// Returns a FunctionalDataOperation
// Can be used to compose larger opearations, but still not inituitive.
func getNameThird(of baby: Baby) -> FunctionalDataOperation<String> {
	return FunctionalDataOperation { _ in
		return baby.name
	}
}
```

If you notice, all the code above is basically just trying to achieve this:

```swift
func getBabyName(of baby: Baby) -> String {
	return baby.name
}
```

Unfortunately, it is not thread safe. It has to be either first wrapped in a perform, or be converted into `FunctionalDataOperation`. Having said that, we will try solving it with `map`.

```swift
extension FunctionalDataOperation {
	func map<NewElement>
	( f: @escaping (Element) -> NewElement) -> FunctionalDataOperation<NewElement> {
		return FunctionalDataOperation<NewElement> { context in
			f(self.operate(context))
		}
	}
}
```

One key thing in this new operation is that the transform function would always run on the correct context’s thread. This means that callers of `getBabyName` function no longer have to worry about threading issues.

Here’s how we would have the baby-making operation with `getBabyName`’s transformation.

```swift
let makeBabyOperation: FunctionalDataOperation<Baby> = makeBaby(name: “Bae”)
let getBabyNameSafelyOperation: FunctionalDataOperation<String> =
makeBabyOperation.map(getBabyName)
print(getBabyNameSafelyOperation.operate(context))
// prints “Bae”
// Not removing type-signature to keep it beginner-friendly
```

A breakdown of our operation:

- First, we create an operation that makes a baby named “Bae”.
- Then, we transform the result of the baby-operation into just its name with `getBabyName`.
- Finally, we “operate” the `FunctionalDataOperation` (on the right context) to get its name String.

## FlatMap

Remember, not all functional programming containers have a `flatMap` operation. Having said that, here’s a flatMap implementation for our use-case:

```swift
extension FunctionalDataOperation {
	func flatMap<B>(_ f: @escaping (A) -> FunctionalDataOperation<B>) -> FunctionalDataOperation<B> {
		return FunctionalDataOperation<B> { context in
			f(self.operate(context)).operate(context)
		}
	}
}
```

Then, we can start writing a convenience method that creates a `FunctionalDataOperation` (and saves the context). Please take note we’re using `try!` in current implementation, a more thorough error-handling will be covered in an upcoming article.

```swift
extension FunctionalDataOperation {
	static func save() -> FunctionalDataOperation<()> {
		return FunctionalDataOperation<()> { context in
			try! context.save()
		}
	}
}
```

For instance, we need to make a baby and save the context. One way to start with is by looking at how we want the calling code to look like:

```swift
let makeBabyOperation: FunctionalDataOperation<()> = makeBaby(name: “Bae”).save()
```

As we can see, calling `save()` at the end of FunctionalDataOperation chain doesn’t return any values. However, having access to the previous value can make things easier in certain situations, so we’ll need to make a bit of changes to the code.

```swift
let makeBabyOperation: FunctionalDataOperation<Baby> = makeBaby(name: “Bae”).save()
```

If we just look at the initial signature, the first implementation might look like this.

```swift
extension FunctionalDataOperation {
	func save() -> FunctionalDataOperation {
		return FunctionalDataOperation { context in
			let result = self.operate(context)
			try! context.save()
			return result
		}
	}
}
```

Although it does its job, the function is still very imperative. Since we already wrapped `try`! `context.save()` in a `FunctionalDataOperation`, perhaps we can use map to bring it up a notch?

```swift
extension FunctionalDataOperation {
	func save() -> FunctionalDataOperation {
		return FunctionalDataOperation { context in
			let aValue: A = self.operate(context)
			let saveAndReturn = FunctionalDataOperation.save().map { _ in aValue }
			return saveAndReturn.operate(context)
		}
	}
}
```

First, we operate self to get an “A” value, then we run a save operation and transform its Void output into the A type return. We then call operate in order to return the raw result, instead of returning a `FunctionalDataOperation`.

However, can we do better?

Calling operateinside `FunctionalDataOperation` haven’t we seen this pattern before? It’s in the implementation of `map` and `flatMap`! So, we can just let them to do the operate call.

```swift
extension FunctionalDataOperation {
	func save() -> FunctionalDataOperation {
		return flatMap { aValue in
			FunctionalDataOperation.save().map { _ in aValue }
		}
	}
}
```

If you have read my previous article about `Result` type, this pattern should look familiar to you. Otherwise, you can try breaking down the process for easier digest.

Now, we have implemented two very powerful functional programming operators. We can still make our `makeBaby` method even more succinct. But hang on! We need two more FP operators.

## Zip

This signature shouldn’t be too foreign if you are familiar with `zip` for Swift’s `Array`. The implementation is pretty trivial, all it does is creating a brand-new DataOperation that returns a tuple with aOp and bOp’s result.

```swift
func zip<A, B>(_ aOp: FunctionalDataOperation<A>, _ bOp: FunctionalDataOperation<B>) ->
FunctionalDataOperation<(A,B)> {
    return FunctionalDataOperation { context in
        return (aOp.operate(in: context), bOp.operate(in: context))
    }
}
```

Zip is very useful when we have multiple things to fetch, and we could only do something after they both have returned.

## Traversable

I have to admit that I am not very well-versed in Traversable, but from my experience I do know containers with this attribute have a `sequence` function that looks something like this.

```swift
func sequence<A>(_ ops: [FunctionalDataOperation<A>]) -> FunctionalDataOperation<[A]>
```

So `Array` is the container that is `traversable` here and sequence flips the Array container with `FunctionalDataOperation`. The implementation is rather straightforward.

```swift
func sequence<A>(_ ops: [FunctionalDataOperation<A>]) -> FunctionalDataOperation<[A]> {
	return FunctionalDataOperation<[A]> { context in
		ops.map { $0.operate(context) }
	}
}
```

Let’s have a breakdown here:

- We first transform the array of `FunctionalDataOperation` into values of “A”s by “operating” them within the context.
- Then, wrapping the whole thing in another FunctionalDataOperation.
- With that, we can start cleaning up our clunky `makeBaby` function!

```swift
func makeBabies(names: [String]) -> FunctionalDataOperation<[Baby]> {
	let makeBabyOperation: [FunctionalDataOperation<Baby>] = names.map(makeBaby)
	let makeBabiesOperation: FunctionalDataOperation<[Baby]> = sequence(makeBabyOperation)

	return makeBabiesOperation
}
```

And…that’s all! We have successfully transformed the array of names into an array of baby-making operations, then we use `sequence` to flip the containers so that the function only needs to return one `FunctionalDataOperation`.

## Conclusion

In this article, we learnt about “making babies” the safe way by introducing the concept of container (i.e. FunctionalDataOperation) in functional programming. And, having implemented functional operators like map, flapMapand and zip, we are now better equipped to build complex functionalities much more concisely.

## Up next

As you might remember, try! was used in this article. Hence, we will need to address the lack of a proper error handling in our baby-making process. This is so that the code can be more robust.

Feel free to share your thoughts with me! Thanks😊
